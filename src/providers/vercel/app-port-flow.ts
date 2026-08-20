/**
 * Zero-configuration public app routes for a Vercel devbox.
 *
 * Runs after the remote checkout is ready and before readiness is rendered:
 * reconcile any pending route update, scan the remote checkout for app-port
 * candidates, decide which of them to expose, and apply the full desired port
 * set to the running Sandbox without recreating it.
 *
 * Everything happens under the branch metadata lock. A route update is written
 * as a pending `{ previous, desired }` record first and committed after, so a
 * crash between the two leaves a route set that the next attach can reconcile
 * against the Sandbox's actual routes rather than an untracked public port.
 */
import type { Writable } from 'node:stream';
import {
  APP_PORT_DETECTOR_VERSION,
  describeAppPortCandidate,
  type AppPortCandidate,
} from './app-ports.js';
import { scanRemoteAppPorts } from './app-port-scan.js';
import { promptForAppPorts } from './app-port-prompt.js';
import {
  appPortsOf,
  buildDesiredPortSet,
  DEVBOX_NOVNC_PROXY_PORT,
  MAX_VERCEL_SANDBOX_PORTS,
  resolveDevcontainerPorts,
  samePortSet,
} from './ports.js';
import type {
  VercelAppPortSelection,
  VercelBranchMetadata,
  VercelBranchMetadataInput,
  VercelBranchMetadataStore,
  VercelPendingAppPorts,
} from './metadata.js';
import type { VercelSandboxClient, VercelSandboxHandle } from './client.js';
import type { ProviderInput } from '../types.js';

export type AppPortPrompt = typeof promptForAppPorts;

/**
 * The scan is two short commands on a Sandbox that is already up. Bound it
 * separately from the rest of the flow, which waits on a human at the prompt.
 */
export const APP_PORT_SCAN_TIMEOUT_MS = 60_000;

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
}

export interface AppPortFlowResult {
  /** Inferred/opted-in app ports now exposed. */
  selected: number[];
  /** Full port set believed to be on the Sandbox. */
  applied: number[];
  /** True when this run changed the Sandbox's route set. */
  updated: boolean;
  /** Framework labels for the selected ports, for route rendering. */
  labels: Record<number, string>;
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
  const configured = appPortsOf((await resolveDevcontainerPorts(options.repoRoot)).ports);
  const actual = appPortsOf((options.sandbox.routes ?? []).map((route) => route.port));
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

  const revision = scan.revision;
  if (revision === undefined) {
    if (options.exposePorts !== undefined) {
      options.stderr.write(
        'app ports: --expose-ports was not applied because the remote checkout revision could not be read\n',
      );
    }
    return unchanged(previousSelection, actual, scan.detection.candidates);
  }

  const { candidates, conflicting, fingerprint } = scan.detection;
  const reusable = previousSelection !== undefined
    && previousSelection.detectorVersion === APP_PORT_DETECTOR_VERSION
    && previousSelection.fingerprint === fingerprint
    && previousSelection.revision === revision;

  let selected: number[];
  if (options.exposePorts !== undefined) {
    selected = [...options.exposePorts];
    options.stderr.write(`app ports: exposing ${formatPorts(selected)} from --expose-ports\n`);
  } else if (reusable) {
    selected = [...previousSelection.selected];
    if (selected.length > 0) {
      options.stderr.write(`app ports: reusing the confirmed selection ${formatPorts(selected)}\n`);
    }
  } else if (candidates.length > 0 && !candidatesFit(configured, candidates)) {
    // Offering a port that cannot be applied would turn a keystroke into a
    // failed boot, so report the capacity instead of asking.
    selected = [...(previousSelection?.selected ?? [])];
    options.stderr.write(
      `app ports: not offering ${formatPorts(candidatePorts(candidates))}; `
      + `${configured.length} configured port(s) plus the reserved noVNC port ${DEVBOX_NOVNC_PROXY_PORT} `
      + `leave room for ${remainingCapacity(configured)} more\n`,
    );
  } else if (options.tty) {
    const result = await (options.prompt ?? promptForAppPorts)({
      stdin: options.stdin,
      stderr: options.stderr,
      configured,
      retained: previousSelection?.selected ?? [],
      candidates,
      conflicting,
    });
    // Rejecting or editing replaces only the inferred selection this flow
    // owns; the trusted configured ports are added back below regardless.
    selected = [...result.selected];
  } else {
    selected = [...(previousSelection?.selected ?? [])];
    if (candidates.length === 0) {
      options.stderr.write(
        selected.length === 0
          ? 'app ports: no app ports were inferred from the remote checkout;'
            + ` expose them with: devbox ${options.branch} --provider vercel --expose-ports <list>\n`
          : `app ports: no app ports were inferred; keeping ${formatPorts(selected)}\n`,
      );
    } else {
      writeNonInteractiveNotice(options, candidates, selected);
    }
  }

  const desired = buildDesiredPortSet(configured, selected);
  const labels = frameworkLabels(candidates, selected);
  const previous = buildDesiredPortSet(actual, []);
  if (samePortSet(desired, previous)) {
    await commitSelection(options, metadata, selected, desired, fingerprint, revision, previousSelection);
    return { selected, applied: desired, updated: false, labels };
  }

  const pending: VercelPendingAppPorts = {
    previous,
    desired,
    selected,
    fingerprint,
    detectorVersion: APP_PORT_DETECTOR_VERSION,
    revision,
  };
  await options.branchStore.write(branchInput(metadata, previousSelection, pending));
  try {
    await options.client.updatePorts(
      options.sandbox,
      desired,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    // The pending record is durable, so reconcile against the Sandbox's real
    // route set rather than guessing whether the update landed.
    await reconcilePendingAppPorts(options, await options.branchStore.read());
    throw error;
  }
  const selection: VercelAppPortSelection = {
    selected,
    applied: desired,
    fingerprint,
    detectorVersion: APP_PORT_DETECTOR_VERSION,
    revision,
  };
  await options.branchStore.write(branchInput(metadata, selection, undefined));
  return { selected, applied: desired, updated: true, labels };
}

/**
 * Reconcile a durable pending record against the Sandbox's actual routes.
 *
 * An already-applied desired set is committed, an unapplied pending set is
 * cleared, and anything else is restored to the recorded previous set before
 * the record is cleared. An unknown route set is never treated as committed.
 */
async function reconcilePendingAppPorts(
  options: AppPortFlowOptions,
  metadata: VercelBranchMetadata | null,
): Promise<VercelBranchMetadata | null> {
  const pending = metadata?.pendingAppPorts;
  if (!metadata || !pending) return metadata;
  const actual = buildDesiredPortSet(
    appPortsOf((options.sandbox.routes ?? []).map((route) => route.port)),
    [],
  );

  if (samePortSet(actual, pending.desired)) {
    const selection: VercelAppPortSelection = {
      selected: pending.selected,
      applied: pending.desired,
      fingerprint: pending.fingerprint,
      detectorVersion: pending.detectorVersion,
      revision: pending.revision,
    };
    options.stderr.write(
      `app ports: committing the interrupted route update ${formatPorts(pending.desired)}\n`,
    );
    return writeBranch(options, metadata, selection, undefined);
  }
  if (samePortSet(actual, pending.previous)) {
    options.stderr.write('app ports: clearing an interrupted route update that never applied\n');
    return writeBranch(options, metadata, metadata.appPorts, undefined);
  }
  options.stderr.write(
    `app ports: restoring ${formatPorts(pending.previous)} after an interrupted route update\n`,
  );
  await options.client.updatePorts(
    options.sandbox,
    pending.previous,
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return writeBranch(options, metadata, metadata.appPorts, undefined);
}

async function commitSelection(
  options: AppPortFlowOptions,
  metadata: VercelBranchMetadata | null,
  selected: number[],
  desired: number[],
  fingerprint: string,
  revision: string,
  previousSelection: VercelAppPortSelection | undefined,
): Promise<void> {
  const selection: VercelAppPortSelection = {
    selected,
    applied: desired,
    fingerprint,
    detectorVersion: APP_PORT_DETECTOR_VERSION,
    revision,
  };
  if (previousSelection && sameSelection(previousSelection, selection)) return;
  await writeBranch(options, metadata, selection, undefined);
}

async function writeBranch(
  options: AppPortFlowOptions,
  metadata: VercelBranchMetadata | null,
  appPorts: VercelAppPortSelection | undefined,
  pendingAppPorts: VercelPendingAppPorts | undefined,
): Promise<VercelBranchMetadata | null> {
  await options.branchStore.write(branchInput(metadata, appPorts, pendingAppPorts));
  return options.branchStore.read();
}

/** Rebuild the stored record with new app-port fields; omission clears them. */
function branchInput(
  metadata: VercelBranchMetadata | null,
  appPorts: VercelAppPortSelection | undefined,
  pendingAppPorts: VercelPendingAppPorts | undefined,
): VercelBranchMetadataInput {
  return {
    ...(metadata?.identity === undefined ? {} : { identity: metadata.identity }),
    ...(metadata?.sandboxId === undefined ? {} : { sandboxId: metadata.sandboxId }),
    ...(metadata?.snapshotIds === undefined ? {} : { snapshotIds: metadata.snapshotIds }),
    ...(metadata?.residual === undefined ? {} : { residual: metadata.residual }),
    ...(metadata?.configuration === undefined ? {} : { configuration: metadata.configuration }),
    ...(metadata?.displayCredentials === undefined ? {} : { displayCredentials: metadata.displayCredentials }),
    ...(appPorts === undefined ? {} : { appPorts }),
    ...(pendingAppPorts === undefined ? {} : { pendingAppPorts }),
  };
}

function writeNonInteractiveNotice(
  options: AppPortFlowOptions,
  candidates: readonly AppPortCandidate[],
  retained: readonly number[],
): void {
  const skipped = [...new Set(candidates.map(({ port }) => port))].sort((left, right) => left - right);
  const detail = candidates
    .map((candidate) => `${candidate.port} (${describeAppPortCandidate(candidate)})`)
    .join(', ');
  options.stderr.write(
    `app ports: skipped ${detail} because this run is not interactive\n`
    + `  expose them with: devbox ${options.branch} --provider vercel --expose-ports ${skipped.join(',')}\n`
    + (retained.length === 0 ? '' : `  keeping the previously confirmed ${formatPorts(retained)}\n`),
  );
}

function candidatePorts(candidates: readonly AppPortCandidate[]): number[] {
  return [...new Set(candidates.map(({ port }) => port))].sort((left, right) => left - right);
}

/** Room left for app ports once the configured set and reserved noVNC are in. */
function remainingCapacity(configured: readonly number[]): number {
  const reserved = new Set([...configured, DEVBOX_NOVNC_PROXY_PORT]);
  return MAX_VERCEL_SANDBOX_PORTS - reserved.size;
}

function candidatesFit(
  configured: readonly number[],
  candidates: readonly AppPortCandidate[],
): boolean {
  const additional = candidatePorts(candidates).filter((port) => !configured.includes(port));
  return additional.length <= remainingCapacity(configured);
}

function frameworkLabels(
  candidates: readonly AppPortCandidate[],
  selected: readonly number[],
): Record<number, string> {
  const labels: Record<number, string> = {};
  for (const candidate of candidates) {
    if (!selected.includes(candidate.port) || labels[candidate.port] !== undefined) continue;
    labels[candidate.port] = candidate.framework;
  }
  return labels;
}

function unchanged(
  previousSelection: VercelAppPortSelection | undefined,
  actual: readonly number[],
  candidates: readonly AppPortCandidate[],
): AppPortFlowResult {
  const selected = [...(previousSelection?.selected ?? [])];
  return {
    selected,
    applied: buildDesiredPortSet(actual, []),
    updated: false,
    labels: frameworkLabels(candidates, selected),
  };
}

function sameSelection(left: VercelAppPortSelection, right: VercelAppPortSelection): boolean {
  return left.fingerprint === right.fingerprint
    && left.detectorVersion === right.detectorVersion
    && left.revision === right.revision
    && samePortSet(left.selected, right.selected)
    && samePortSet(left.applied, right.applied);
}

function scanSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(APP_PORT_SCAN_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function formatPorts(ports: readonly number[]): string {
  return ports.length === 0 ? 'no app ports' : ports.join(', ');
}
