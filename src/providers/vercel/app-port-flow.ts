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
  type AppPortCandidate,
} from './app-ports.js';
import { decideAppPortSelection } from './app-port-decision.js';
import { scanRemoteAppPorts } from './app-port-scan.js';
import { promptForAppPorts } from './app-port-prompt.js';
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
} from './metadata.js';
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

  const decision = decideAppPortSelection({
    branch: options.branch,
    ...(options.exposePorts === undefined ? {} : { exposePorts: options.exposePorts }),
    reusable,
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
  await options.branchStore.write(withAppPortFields(metadata, previousSelection, pending));
  try {
    await options.client.updatePorts(
      options.sandbox,
      desired,
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
      selected: [...(previousSelection?.selected ?? [])],
      applied: previous,
      updated: false,
      labels: frameworkLabels(candidates, previousSelection?.selected ?? []),
    };
  }
  const selection: VercelAppPortSelection = {
    selected,
    applied: desired,
    fingerprint,
    detectorVersion: APP_PORT_DETECTOR_VERSION,
    revision,
  };
  await options.branchStore.write(withAppPortFields(metadata, selection, undefined));
  return { selected, applied: desired, updated: true, labels };
}

/**
 * Reconcile a durable pending record against the Sandbox's actual routes.
 *
 * An already-applied desired set is committed, an unapplied pending set is
 * cleared, and anything else is restored to the recorded previous set before
 * the record is cleared. An unknown route set is never treated as committed.
 */
export async function reconcilePendingAppPorts(
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
  await options.branchStore.write(withAppPortFields(metadata, appPorts, pendingAppPorts));
  return options.branchStore.read();
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
