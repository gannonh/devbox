/**
 * Zero-configuration public app routes for a Vercel devbox.
 *
 * Runs after the remote checkout is ready and before readiness is rendered:
 * reconcile any pending route update, scan the remote checkout for app-port
 * candidates, decide which of them to expose, and publish each accepted
 * logical port through a sandbox-local relay rather than the app's own
 * listener. A Vercel route needs an externally reachable listener and an
 * ordinary dev command binds loopback and checks the Host it is handed, so
 * relaying is what lets the project's normal dev command work unedited.
 *
 * Everything happens under the branch metadata lock, in one order: desired
 * relay listeners ready, then the route update, then the metadata commit, then
 * the obsolete relays are stopped. A crash anywhere in that sequence leaves a
 * pending `{ previous, desired }` record the next attach reconciles against
 * the Sandbox's actual routes and its PID-verified relay processes, rather
 * than an untracked public port or a route that points at nothing.
 */
import type { Writable } from 'node:stream';
import {
  APP_PORT_DETECTOR_VERSION,
  type AppPortCandidate,
} from './app-ports.js';
import { decideAppPortSelection } from './app-port-decision.js';
import { scanRemoteAppPorts } from './app-port-scan.js';
import { promptForAppPorts } from './app-port-prompt.js';
import {
  DEFAULT_APP_PORT_LABEL,
  provisionRelays,
  stopRelays,
  verifyRelayMappings,
  type RelayManagerOptions,
  type VercelRelayMapping,
} from './app-relay.js';
import {
  appPortsOf,
  buildDesiredPortSet,
  resolveDevcontainerPorts,
  samePortSet,
} from './ports.js';
import {
  withAppPortFields,
  type VercelAppPortSelection,
  type VercelBranchMetadata,
  type VercelBranchMetadataStore,
  type VercelPendingAppPorts,
  type VercelRelayState,
} from './metadata.js';
import { sandboxIdentifier } from './lifecycle.js';
import type { VercelSandboxClient, VercelSandboxHandle } from './client.js';
import type { ProviderInput } from '../types.js';
import { redactSecrets } from './redaction.js';

export type AppPortPrompt = typeof promptForAppPorts;

/**
 * Why the flow is running. A boot is already a decision point, so its prompt
 * defaults to accepting what was detected. A resume is usually "get me back
 * in" -- often a second terminal beside a running dev server -- so its prompt
 * defaults to keeping whatever is already exposed and never stands between the
 * user and their shell.
 */
export type AppPortFlowMode = 'boot' | 'resume';

/**
 * The scan is two short commands on a Sandbox that is already up. Bound it
 * separately from the rest of the flow, which waits on a human at the prompt.
 */
export const APP_PORT_SCAN_TIMEOUT_MS = 60_000;

/**
 * Metadata stand-in when `git rev-parse HEAD` could not be read.
 *
 * Required because committed selections always carry a 40-hex revision. A later
 * successful rev-parse will never equal this value, so a selection recorded
 * while the checkout was unreadable is never silently reused as "same tree".
 */
export const UNRESOLVED_CHECKOUT_REVISION = '0'.repeat(40);

export interface AppPortFlowOptions {
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  branchStore: VercelBranchMetadataStore;
  /** Host repository root; the trusted explicit `forwardPorts` source. */
  repoRoot: string;
  /** Repository working directory inside the Sandbox. */
  workspace: string;
  branch: string;
  tty: boolean;
  stdin: ProviderInput;
  stderr: Writable;
  /** Explicit non-interactive opt-in from `--expose-ports`. */
  exposePorts?: readonly number[];
  secrets?: readonly string[];
  signal?: AbortSignal;
  prompt?: AppPortPrompt;
  mode?: AppPortFlowMode;
  /** Rebind the last committed route selection after stable checkout evidence. */
  restoreRecorded?: boolean;
}

export interface AppPortFlowResult {
  /** Inferred/opted-in app ports now exposed, as logical ports. */
  selected: number[];
  /** Full port set believed to be on the Sandbox: relay ports plus noVNC. */
  applied: number[];
  /** True when this run changed the Sandbox's route set. */
  updated: boolean;
  /** Framework labels keyed by logical port, for route rendering. */
  labels: Record<number, string>;
  /** Published `relayPort -> logicalPort` mappings, for route rendering. */
  relays: VercelRelayMapping[];
}

export async function applyAppPorts(options: AppPortFlowOptions): Promise<AppPortFlowResult> {
  return options.branchStore.withLock(() => runAppPortFlow(options));
}

async function runAppPortFlow(options: AppPortFlowOptions): Promise<AppPortFlowResult> {
  let metadata = await options.branchStore.read();
  metadata = await reconcilePendingAppPorts(options, metadata);

  // The explicit host configuration is validated before any candidate can be
  // considered, so a broken forwardPorts list can never be masked by a
  // detected port that happens to be valid.
  const devcontainer = await resolveDevcontainerPorts(options.repoRoot);
  const configured = appPortsOf(devcontainer.ports);
  const previousSelection = metadata?.appPorts;

  const scan = await scanRemoteAppPorts({
    sandbox: options.sandbox,
    client: options.client,
    workspace: options.workspace,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    signal: scanSignal(options.signal),
  });
  for (const warning of scan.warnings) options.stderr.write(`app ports: ${warning}\n`);
  if (scan.workspaces.length > 0 && scan.detection.candidates.length === 0) {
    // Saying which members were read turns "nothing found" into something the
    // user can act on: either the app is elsewhere, or its dev script is one
    // the grammar deliberately does not interpret.
    options.stderr.write(
      `app ports: scanned ${scan.workspaces.length} workspace manifest(s): ${scan.workspaces.join(', ')}\n`,
    );
  }

  // A missing revision means inference was skipped (scan already warned and
  // returned an empty candidate set). Configured forwardPorts and an explicit
  // --expose-ports list are still trusted and must still be published: the
  // scan is enrichment, not a gate on the host's .devcontainer ports.
  const revision = scan.revision;
  const { candidates, conflicting, fingerprint } = scan.detection;
  const recorded = recordedSelection(options, metadata);

  // A snapshot retains the checkout and the dependency tree, but its route
  // processes do not survive the stop. Rebinding the committed choice is safe
  // only when the detector, checkout revision, and package fingerprint still
  // agree. Otherwise the normal decision flow must get a chance to rescan and
  // prompt, because the recorded app may have moved or disappeared.
  const recordedMatchesCheckout = previousSelection !== undefined
    && previousSelection.detectorVersion === APP_PORT_DETECTOR_VERSION
    && revision !== undefined
    && previousSelection.revision === revision
    && previousSelection.fingerprint === fingerprint;
  if (options.restoreRecorded && previousSelection !== undefined && recordedMatchesCheckout) {
    const logical = appPortsOf(buildDesiredPortSet(configured, previousSelection.selected));
    const recordedLabels = Object.fromEntries(
      previousSelection.relays.map((mapping) => [mapping.logicalPort, mapping.label]),
    );
    return publishRelayRoutes(options, {
      metadata,
      // The snapshot has no live relay processes, so deliberately bypass the
      // same-Sandbox reusable selection and provision fresh relays from the
      // retained logical choice.
      recorded: undefined,
      logical,
      labels: { ...recordedLabels, ...devcontainer.labels },
      selected: [...previousSelection.selected],
      fingerprint,
      revision,
    });
  }

  const reusable = previousSelection !== undefined
    && previousSelection.detectorVersion === APP_PORT_DETECTOR_VERSION
    && previousSelection.fingerprint === fingerprint
    && revision !== undefined
    && previousSelection.revision === revision;

  const decision = decideAppPortSelection({
    branch: options.branch,
    ...(options.exposePorts === undefined ? {} : { exposePorts: options.exposePorts }),
    reusable,
    inferenceAvailable: revision !== undefined,
    previousSelected: previousSelection?.selected ?? [],
    candidates,
    configured,
    tty: options.tty,
  });

  let selected: number[];
  if (decision.kind === 'prompt') {
    const result = await (options.prompt ?? promptForAppPorts)({
      stdin: options.stdin,
      stderr: options.stderr,
      configured,
      retained: previousSelection?.selected ?? [],
      candidates,
      conflicting,
      keepOnEmptyAnswer: options.mode === 'resume',
    });
    // Rejecting or editing replaces only the inferred selection this flow
    // owns; the trusted configured ports are added back below regardless.
    selected = [...result.selected];
  } else {
    selected = decision.selected;
    if (decision.notice !== undefined) options.stderr.write(`${decision.notice}\n`);
  }

  // One logical app port still costs exactly one exposed slot, so the verified
  // 14-route ceiling is enforced here, on the ports the user chose, before any
  // relay is started for them.
  const logical = appPortsOf(buildDesiredPortSet(configured, selected));
  const labels = appPortLabels(logical, candidates, devcontainer.labels);
  return publishRelayRoutes(options, {
    metadata,
    recorded,
    logical,
    labels,
    selected: appPortsOf(selected),
    fingerprint,
    // Metadata requires a 40-hex revision; the all-zero sentinel marks an
    // unresolved checkout so a later successful rev-parse never compares equal
    // and silently reuses a selection bound to "we did not know".
    revision: revision ?? UNRESOLVED_CHECKOUT_REVISION,
  });
}

interface PublishRequest {
  metadata: VercelBranchMetadata | null;
  recorded: VercelAppPortSelection | undefined;
  logical: number[];
  labels: Record<number, string>;
  selected: number[];
  fingerprint: string;
  revision: string;
}

/**
 * Start the desired relays, publish them, and commit -- in that order.
 *
 * Nothing reaches the route API until every listener it will name is bound and
 * held, and nothing is committed until the route API has accepted the set. The
 * relays a changed selection orphans are stopped last, because a stopped relay
 * that is still published is the one failure this order cannot undo.
 */
async function publishRelayRoutes(
  options: AppPortFlowOptions,
  request: PublishRequest,
): Promise<AppPortFlowResult> {
  const relayOptions = relayManagerOptions(options);
  const actual = buildDesiredPortSet(appPortsOf(routePorts(options.sandbox)), []);
  const previous: VercelRelayState = {
    relays: request.recorded?.relays ?? [],
    applied: request.recorded?.applied ?? actual,
  };

  // The cheapest correct outcome: the same logical ports, the same live relay
  // processes, and routes that already name them. No API call, no restart.
  if (
    request.recorded !== undefined
    && samePortSet(request.recorded.selected, request.selected)
    && sameLogicalPorts(request.recorded.relays, request.logical)
    && samePortSet(actual, request.recorded.applied)
    && await verifyRelayMappings(relayOptions, request.recorded.relays)
  ) {
    const relays = relabel(request.recorded.relays, request.labels);
    await commitSelection(options, request, relays, actual, request.recorded);
    return result(request, relays, actual, false);
  }

  const provisioned = await provisionRelays(relayOptions, {
    logical: request.logical.map((port) => ({ port, label: request.labels[port] ?? DEFAULT_APP_PORT_LABEL })),
    existing: request.recorded?.relays ?? [],
    routePorts: routePorts(options.sandbox),
  });
  const desiredApplied = buildDesiredPortSet(provisioned.mappings.map(({ relayPort }) => relayPort), []);
  const obsolete = (request.recorded?.relays ?? [])
    .filter((mapping) => !request.logical.includes(mapping.logicalPort))
    .map(({ logicalPort }) => logicalPort);

  // Equal port sets means the routes already name these listeners, and a
  // route update would regenerate every subdomain for nothing.
  if (samePortSet(desiredApplied, actual)) {
    await commitSelection(options, request, provisioned.mappings, desiredApplied, request.recorded);
    await stopObsoleteRelays(options, relayOptions, obsolete);
    return result(request, provisioned.mappings, desiredApplied, false);
  }

  const pending: VercelPendingAppPorts = {
    sandboxId: sandboxIdentifier(options.sandbox),
    previous,
    desired: { relays: provisioned.mappings, applied: desiredApplied },
    selected: request.selected,
    fingerprint: request.fingerprint,
    detectorVersion: APP_PORT_DETECTOR_VERSION,
    revision: request.revision,
  };
  await options.branchStore.write(withAppPortFields(request.metadata, request.recorded, pending));
  try {
    await options.client.updatePorts(
      options.sandbox,
      desiredApplied,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    // Leave the pending record alone. This handle's routes may still match
    // `previous` even when the service already applied `desired` (timeout after
    // a successful update), and reconciling against that stale snapshot would
    // clear pending and can roll the next attach back to the older selection.
    const detail = redactSecrets(error, options.secrets ?? []);
    options.stderr.write(
      `app ports: route update failed (${detail}); `
      + 'pending retained so the next attach can reconcile against fresh routes\n',
    );
    return {
      selected: [...(request.recorded?.selected ?? [])],
      applied: actual,
      updated: false,
      labels: request.labels,
      relays: [...previous.relays],
    };
  }
  await commitSelection(options, request, provisioned.mappings, desiredApplied, undefined);
  await stopObsoleteRelays(options, relayOptions, obsolete);
  return result(request, provisioned.mappings, desiredApplied, true);
}

/**
 * Reconcile a durable pending record against actual routes and live relays.
 *
 * An already-applied desired state is committed, an unapplied pending state is
 * cleared, and anything else is restored to the recorded previous set before
 * the record is cleared. A state is only "applied" when its routes match *and*
 * its relay processes verify, so an unverified route is never reported ready.
 */
export async function reconcilePendingAppPorts(
  options: AppPortFlowOptions,
  metadata: VercelBranchMetadata | null,
): Promise<VercelBranchMetadata | null> {
  const pending = metadata?.pendingAppPorts;
  if (!metadata || !pending) return metadata;
  if (pending.sandboxId !== sandboxIdentifier(options.sandbox)) {
    // The record describes another Sandbox instance; its processes cannot
    // exist here, so there is nothing to commit and nothing to roll back.
    options.stderr.write('app ports: discarding a route update recorded for a previous sandbox\n');
    return writeBranch(options, metadata, metadata.appPorts, undefined);
  }
  const relayOptions = relayManagerOptions(options);
  const actual = buildDesiredPortSet(appPortsOf(routePorts(options.sandbox)), []);

  if (
    samePortSet(actual, pending.desired.applied)
    && await verifyRelayMappings(relayOptions, pending.desired.relays)
  ) {
    const selection: VercelAppPortSelection = {
      sandboxId: pending.sandboxId,
      selected: pending.selected,
      relays: pending.desired.relays,
      applied: pending.desired.applied,
      fingerprint: pending.fingerprint,
      detectorVersion: pending.detectorVersion,
      revision: pending.revision,
    };
    options.stderr.write(
      `app ports: committing the interrupted route update ${formatPorts(pending.selected)}\n`,
    );
    const committed = await writeBranch(options, metadata, selection, undefined);
    await stopObsoleteRelays(
      options,
      relayOptions,
      logicalPortsNotIn(pending.previous.relays, pending.desired.relays),
    );
    return committed;
  }
  if (
    samePortSet(actual, pending.previous.applied)
    && await verifyRelayMappings(relayOptions, pending.previous.relays)
  ) {
    options.stderr.write('app ports: clearing an interrupted route update that never applied\n');
    const cleared = await writeBranch(options, metadata, metadata.appPorts, undefined);
    await stopObsoleteRelays(
      options,
      relayOptions,
      logicalPortsNotIn(pending.desired.relays, pending.previous.relays),
    );
    return cleared;
  }
  options.stderr.write(
    `app ports: restoring ${formatPorts(pending.previous.applied)} after an interrupted route update\n`,
  );
  await options.client.updatePorts(
    options.sandbox,
    pending.previous.applied,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  const restored = await writeBranch(options, metadata, metadata.appPorts, undefined);
  await stopObsoleteRelays(
    options,
    relayOptions,
    logicalPortsNotIn(pending.desired.relays, pending.previous.relays),
  );
  return restored;
}

export function relayManagerOptions(options: AppPortFlowOptions): RelayManagerOptions {
  return {
    sandbox: options.sandbox,
    client: options.client,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/**
 * The committed selection, but only when it describes this Sandbox instance.
 *
 * Relay mappings name processes, and a resumed Sandbox has none of them, so a
 * record from a previous instance is evidence about a box that no longer
 * exists. Ignoring it here is what sends a snapshot resume down the full
 * provisioning path.
 */
function recordedSelection(
  options: AppPortFlowOptions,
  metadata: VercelBranchMetadata | null,
): VercelAppPortSelection | undefined {
  const selection = metadata?.appPorts;
  if (!selection) return undefined;
  return selection.sandboxId === sandboxIdentifier(options.sandbox) ? selection : undefined;
}

async function stopObsoleteRelays(
  options: AppPortFlowOptions,
  relayOptions: RelayManagerOptions,
  logicalPorts: readonly number[],
): Promise<void> {
  if (logicalPorts.length === 0) return;
  try {
    await stopRelays(relayOptions, logicalPorts);
  } catch (error) {
    // The routes that named these relays are already gone, so a leftover
    // process is inert; say so rather than failing a completed transaction.
    options.stderr.write(
      `app ports: could not stop the relay(s) for ${formatPorts(logicalPorts)} `
      + `(${redactSecrets(error, options.secrets ?? [])}); they are no longer published\n`,
    );
  }
}

async function commitSelection(
  options: AppPortFlowOptions,
  request: PublishRequest,
  relays: readonly VercelRelayMapping[],
  applied: readonly number[],
  unchangedFrom: VercelAppPortSelection | undefined,
): Promise<void> {
  const selection: VercelAppPortSelection = {
    sandboxId: sandboxIdentifier(options.sandbox),
    selected: request.selected,
    relays: relays.map((mapping) => ({ ...mapping })),
    applied: [...applied],
    fingerprint: request.fingerprint,
    detectorVersion: APP_PORT_DETECTOR_VERSION,
    revision: request.revision,
  };
  if (unchangedFrom && sameSelection(unchangedFrom, selection)) return;
  await options.branchStore.write(withAppPortFields(request.metadata, selection, undefined));
}

async function writeBranch(
  options: AppPortFlowOptions,
  metadata: VercelBranchMetadata | null,
  appPorts: VercelAppPortSelection | undefined,
  pendingAppPorts: VercelPendingAppPorts | undefined,
): Promise<VercelBranchMetadata | null> {
  await options.branchStore.write(withAppPortFields(metadata, appPorts, pendingAppPorts));
  return options.branchStore.read();
}

function result(
  request: PublishRequest,
  relays: readonly VercelRelayMapping[],
  applied: readonly number[],
  updated: boolean,
): AppPortFlowResult {
  return {
    selected: [...request.selected],
    applied: [...applied],
    updated,
    labels: request.labels,
    relays: relays.map((mapping) => ({ ...mapping })),
  };
}

/**
 * Label a logical port for the route line.
 *
 * The host's `portsAttributes` label wins over a detected framework because it
 * is the one a human wrote. Both are bounded to what metadata will store, so a
 * label can never carry script or path text onto a printed line.
 */
export function appPortLabels(
  logical: readonly number[],
  candidates: readonly AppPortCandidate[],
  configuredLabels: Record<number, string>,
): Record<number, string> {
  const labels: Record<number, string> = {};
  for (const port of logical) {
    const configured = configuredLabels[port];
    const framework = candidates.find((candidate) => candidate.port === port)?.framework;
    const label = sanitizeLabel(configured) ?? sanitizeLabel(framework) ?? DEFAULT_APP_PORT_LABEL;
    labels[port] = label;
  }
  return labels;
}

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?: [A-Za-z0-9][A-Za-z0-9._+-]*)*$/;

function sanitizeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value
    .replace(/[^A-Za-z0-9 ._+-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[._+-]+/, ''))
    .filter((word) => word.length > 0)
    .join(' ')
    .slice(0, 32)
    .trim();
  return LABEL_PATTERN.test(cleaned) ? cleaned : undefined;
}

function relabel(
  relays: readonly VercelRelayMapping[],
  labels: Record<number, string>,
): VercelRelayMapping[] {
  return relays.map((mapping) => ({
    ...mapping,
    label: labels[mapping.logicalPort] ?? mapping.label,
  }));
}

function routePorts(sandbox: VercelSandboxHandle): number[] {
  return (sandbox.routes ?? []).map((route) => route.port);
}

function sameLogicalPorts(
  relays: readonly VercelRelayMapping[],
  logical: readonly number[],
): boolean {
  return samePortSet(relays.map(({ logicalPort }) => logicalPort), logical);
}

/** Logical relay processes that are not part of the other committed state. */
function logicalPortsNotIn(
  source: readonly VercelRelayMapping[],
  target: readonly VercelRelayMapping[],
): number[] {
  const targetPorts = new Set(target.map(({ logicalPort }) => logicalPort));
  return [...new Set(source
    .filter(({ logicalPort }) => !targetPorts.has(logicalPort))
    .map(({ logicalPort }) => logicalPort))];
}

function sameMappings(
  left: readonly VercelRelayMapping[],
  right: readonly VercelRelayMapping[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((mapping) => right.some((other) =>
    other.logicalPort === mapping.logicalPort && other.relayPort === mapping.relayPort));
}

function sameSelection(left: VercelAppPortSelection, right: VercelAppPortSelection): boolean {
  return left.sandboxId === right.sandboxId
    && left.fingerprint === right.fingerprint
    && left.detectorVersion === right.detectorVersion
    && left.revision === right.revision
    && samePortSet(left.selected, right.selected)
    && samePortSet(left.applied, right.applied)
    && sameMappings(left.relays, right.relays)
    && left.relays.every((mapping) => right.relays.some((other) =>
      other.logicalPort === mapping.logicalPort && other.label === mapping.label));
}

function scanSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(APP_PORT_SCAN_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function formatPorts(ports: readonly number[]): string {
  return ports.length === 0 ? 'no app ports' : ports.join(', ');
}
