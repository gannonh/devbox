/**
 * Host-side manager for the sandbox-local app-port relays.
 *
 * A Vercel route needs an externally reachable listener; an ordinary dev
 * command binds loopback and checks the Host header it is handed. So devbox
 * publishes a relay instead of the app: one small fixed-target process per
 * logical app port, and a route that points at the relay's port rather than
 * the app's. The user still sees, and still confirms, the logical port.
 *
 * This module owns the transport half of that contract -- installing the relay
 * runtime, proving a listener is bound before anything is published, and
 * re-verifying recorded processes by PID and start time on re-entry. Which
 * ports to expose remains the app-port flow's decision.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DEVBOX_NOVNC_INTERNAL_PORT,
  DEVBOX_NOVNC_PROXY_PORT,
  DEVBOX_VNC_PORT,
} from './ports.js';
import { redactSecrets } from './redaction.js';
import { currentVercelSessionId } from './session-lease.js';
import type {
  VercelCommandResult,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
} from './client.js';

export const RELAY_RUNTIME_DIRECTORY = '/vercel/.devbox/runtime';
export const RELAY_SCRIPT_PATH = `${RELAY_RUNTIME_DIRECTORY}/app-relay.mjs`;
export const RELAY_CONTROL_PATH = `${RELAY_RUNTIME_DIRECTORY}/app-relay-control.sh`;
export const RELAY_STATE_DIRECTORY = `${RELAY_RUNTIME_DIRECTORY}/relays`;
export const RELAY_COMMAND_TIMEOUT_MS = 60_000;
/** Bound the manager's own retries; the relay retries its bind internally too. */
export const RELAY_START_ATTEMPTS = 3;

const RELAY_SCRIPT_SOURCE = fileURLToPath(new URL('../../../images/vercel/app-relay.mjs', import.meta.url));
const RELAY_CONTROL_SOURCE = fileURLToPath(new URL('../../../images/vercel/app-relay-control.sh', import.meta.url));

/** Ports a relay listener may never occupy, whatever the kernel offers. */
export const RELAY_RESERVED_PORTS: readonly number[] = [
  DEVBOX_VNC_PORT,
  DEVBOX_NOVNC_PROXY_PORT,
  DEVBOX_NOVNC_INTERNAL_PORT,
];

/**
 * The label a mapping carries when nothing describes the port but the user's
 * own request. Rendered as a plain public route rather than a made-up name.
 */
export const DEFAULT_APP_PORT_LABEL = 'app';

/** One committed `relayPort -> localhost:logicalPort` mapping. */
export interface VercelRelayMapping {
  logicalPort: number;
  relayPort: number;
  label: string;
}

/** What the Sandbox reports about a recorded relay process. */
export interface VercelRelayProcess {
  logicalPort: number;
  relayPort: number;
  pid: number;
  running: boolean;
}

export class VercelRelayError extends Error {
  readonly code = 'relay_failed';

  constructor(message: string) {
    super(message);
    this.name = 'VercelRelayError';
  }
}

export interface RelayManagerOptions {
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  secrets?: readonly string[];
  signal?: AbortSignal;
}

export interface RelayLogicalPort {
  port: number;
  label: string;
}

export interface ProvisionRelaysRequest {
  /** The confirmed logical app ports, in the order they should be published. */
  logical: readonly RelayLogicalPort[];
  /** Recorded mappings to prefer when their process is already healthy. */
  existing?: readonly VercelRelayMapping[];
  /** Ports already published on the Sandbox; a relay must not shadow one. */
  routePorts?: readonly number[];
}

export interface ProvisionRelaysResult {
  mappings: VercelRelayMapping[];
  /** Logical ports whose relay process was (re)started by this call. */
  started: number[];
}

/**
 * Install the relay runtime as an overlay under the Sandbox home.
 *
 * Overlaid rather than baked into the image for the same reason the noVNC
 * proxy is: the image is digest-pinned, so a CLI newer than the pin must be
 * able to ship its own relay without waiting for an image promotion.
 */
export async function installRelayRuntime(options: RelayManagerOptions): Promise<void> {
  try {
    await options.client.writeFiles(
      options.sandbox,
      [
        { path: RELAY_SCRIPT_PATH, content: await readFile(RELAY_SCRIPT_SOURCE), mode: 0o700 },
        { path: RELAY_CONTROL_PATH, content: await readFile(RELAY_CONTROL_SOURCE), mode: 0o700 },
      ],
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    throw relayError(`relay runtime install failed: ${redactSecrets(error, options.secrets ?? [])}`, options.secrets);
  }
}

/** Every relay process the Sandbox currently has a record for. */
export async function readRelayProcesses(options: RelayManagerOptions): Promise<VercelRelayProcess[]> {
  const result = await runRelayCommand(options, ['status'], 'relay status');
  if (result.exitCode !== 0) {
    throw relayError(`relay status failed: ${result.output || `exit code ${result.exitCode}`}`, options.secrets);
  }
  return parseRelayRecords(result.rawOutput);
}

/**
 * True when every mapping is backed by a live process on its exact relay port.
 *
 * Deliberately strict: a partially healthy set is not a reusable one, and a
 * relay that came back on a different port describes a route that no longer
 * reaches the app.
 */
export async function verifyRelayMappings(
  options: RelayManagerOptions,
  mappings: readonly VercelRelayMapping[],
): Promise<boolean> {
  if (mappings.length === 0) return true;
  let processes: VercelRelayProcess[];
  try {
    processes = await readRelayProcesses(options);
  } catch {
    return false;
  }
  return mappings.every((mapping) => processes.some((process) =>
    process.running
    && process.logicalPort === mapping.logicalPort
    && process.relayPort === mapping.relayPort));
}

/**
 * Bring the relay set for `logical` up, reusing healthy recorded mappings.
 *
 * Every relay is listening before this returns, which is what makes the
 * transaction order safe: nothing is published until the thing it points at
 * exists.
 */
export async function provisionRelays(
  options: RelayManagerOptions,
  request: ProvisionRelaysRequest,
): Promise<ProvisionRelaysResult> {
  if (request.logical.length === 0) return { mappings: [], started: [] };
  await installRelayRuntime(options);

  const logicalPorts = request.logical.map(({ port }) => port);
  const existing = (request.existing ?? []).filter(({ logicalPort }) => logicalPorts.includes(logicalPort));
  const healthy = await healthyProcesses(options);
  // A published route pointing at one of our own relays is not a collision to
  // avoid -- it is the port we are trying to keep. Every other published port
  // is somebody else's and stays off limits.
  const reusable = new Set<number>([
    ...[...healthy.values()].map(({ relayPort }) => relayPort),
    ...existing.map(({ relayPort }) => relayPort),
  ]);
  const forbidden = new Set<number>([
    ...RELAY_RESERVED_PORTS,
    ...logicalPorts,
    ...[...healthy.values()].map(({ relayPort }) => relayPort),
    ...(request.routePorts ?? []).filter((port) => !reusable.has(port)),
  ]);

  const mappings: VercelRelayMapping[] = [];
  const started: number[] = [];
  for (const { port, label } of request.logical) {
    const live = healthy.get(port);
    if (live !== undefined) {
      forbidden.add(live.relayPort);
      mappings.push({ logicalPort: port, relayPort: live.relayPort, label });
      continue;
    }
    const recorded = existing.find((mapping) => mapping.logicalPort === port);
    const mapping = await startRelay(options, {
      logicalPort: port,
      label,
      forbidden,
      // A resume prefers the port the routes already named, so a reconstructed
      // relay set can often be committed without regenerating every URL.
      ...(recorded === undefined || forbidden.has(recorded.relayPort)
        ? {}
        : { preferred: recorded.relayPort }),
    });
    forbidden.add(mapping.relayPort);
    mappings.push(mapping);
    started.push(port);
  }
  return { mappings, started };
}

/**
 * Live relays keyed by the app port they serve.
 *
 * The Sandbox is the authority on what is running, not the metadata: a
 * reconciliation, a restored route set, or a crashed commit can all leave a
 * healthy relay that no committed record names yet.
 */
async function healthyProcesses(
  options: RelayManagerOptions,
): Promise<Map<number, VercelRelayProcess>> {
  const healthy = new Map<number, VercelRelayProcess>();
  let processes: VercelRelayProcess[];
  try {
    processes = await readRelayProcesses(options);
  } catch {
    // No readable state is the full-provisioning path, not a failure.
    return healthy;
  }
  for (const process of processes) {
    if (process.running && !healthy.has(process.logicalPort)) healthy.set(process.logicalPort, process);
  }
  return healthy;
}

/** Stop the relays for `logicalPorts`; a missing record is already stopped. */
export async function stopRelays(
  options: RelayManagerOptions,
  logicalPorts: readonly number[],
): Promise<void> {
  if (logicalPorts.length === 0) return;
  const result = await runRelayCommand(
    options,
    ['stop', ...logicalPorts.map((port) => String(port))],
    'relay stop',
  );
  if (result.exitCode !== 0) {
    throw relayError(`relay stop failed: ${result.output || `exit code ${result.exitCode}`}`, options.secrets);
  }
}

/** Stop every relay and drop its state; used by `--stop` and `--rm`. */
export async function stopAllRelays(options: RelayManagerOptions): Promise<void> {
  const result = await runRelayCommand(options, ['stop-all'], 'relay stop-all');
  if (result.exitCode !== 0) {
    throw relayError(`relay stop-all failed: ${result.output || `exit code ${result.exitCode}`}`, options.secrets);
  }
}

async function startRelay(
  options: RelayManagerOptions,
  request: {
    logicalPort: number;
    label: string;
    forbidden: ReadonlySet<number>;
    preferred?: number;
  },
): Promise<VercelRelayMapping> {
  const forbidden = [...request.forbidden].filter((port) => port !== request.logicalPort);
  let detail = 'no listener was published';
  for (let attempt = 1; attempt <= RELAY_START_ATTEMPTS; attempt += 1) {
    const result = await runRelayCommand(options, [
      'start',
      String(request.logicalPort),
      attempt === 1 && request.preferred !== undefined ? String(request.preferred) : '-',
      forbidden.length === 0 ? '-' : forbidden.join(','),
    ], `relay start ${request.logicalPort}`);
    if (result.exitCode === 0) {
      const record = parseRelayRecords(result.rawOutput)
        .find((entry) => entry.logicalPort === request.logicalPort);
      // The relay refuses reserved ports itself; re-checking here means a
      // tampered or truncated report can never become a published route.
      if (record !== undefined && !request.forbidden.has(record.relayPort)) {
        return { logicalPort: request.logicalPort, relayPort: record.relayPort, label: request.label };
      }
      detail = record === undefined
        ? 'no listener was published'
        : `listener port ${record.relayPort} collides with a reserved or published port`;
    } else {
      detail = result.output || `exit code ${result.exitCode}`;
    }
  }
  throw relayError(
    `relay for app port ${request.logicalPort} did not start after ${RELAY_START_ATTEMPTS} attempts: ${detail}`,
    options.secrets,
  );
}

/**
 * One JSON object per line, with anything else on the stream ignored.
 *
 * Shell startup noise and log lines share these streams; a report is only
 * trusted when every field it needs parses as a port-shaped integer.
 */
export function parseRelayRecords(output: string): VercelRelayProcess[] {
  const records: VercelRelayProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    const candidate = value as Record<string, unknown>;
    const logicalPort = portOf(candidate.logicalPort);
    const relayPort = portOf(candidate.relayPort);
    if (logicalPort === undefined) continue;
    const running = candidate.running !== false && relayPort !== undefined;
    records.push({
      logicalPort,
      relayPort: relayPort ?? 0,
      pid: typeof candidate.pid === 'number' && Number.isInteger(candidate.pid) ? candidate.pid : 0,
      running,
    });
  }
  return records;
}

function portOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return undefined;
  }
  return value;
}

async function runRelayCommand(
  options: RelayManagerOptions,
  args: readonly string[],
  operation: string,
): Promise<{ exitCode: number; output: string; rawOutput: string }> {
  const request: VercelRunCommandRequest = {
    cmd: 'bash',
    args: [RELAY_CONTROL_PATH, ...args],
    timeoutMs: RELAY_COMMAND_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const sessionId = currentVercelSessionId(options.sandbox);
  if (sessionId === null) {
    throw relayError(`${operation} command failed: Vercel current session ID is unavailable`, options.secrets);
  }
  let result: VercelCommandResult;
  try {
    result = await options.client.runCommand(options.sandbox, request, {
      expectedSessionId: sessionId,
      secrets: options.secrets,
    });
  } catch (error) {
    throw relayError(`${operation} command failed: ${redactSecrets(error, options.secrets ?? [])}`, options.secrets);
  }
  const parts: string[] = [];
  try {
    if (result.stdout) parts.push(await result.stdout(options.signal === undefined ? undefined : { signal: options.signal }));
    if (result.stderr) parts.push(await result.stderr(options.signal === undefined ? undefined : { signal: options.signal }));
  } catch (error) {
    throw relayError(`${operation} output failed: ${redactSecrets(error, options.secrets ?? [])}`, options.secrets);
  }
  const rawOutput = parts.join('\n');
  return {
    exitCode: result.exitCode ?? -1,
    output: redactSecrets(rawOutput.trim(), options.secrets ?? []),
    rawOutput,
  };
}

function relayError(message: string, secrets: readonly string[] | undefined): VercelRelayError {
  return new VercelRelayError(redactSecrets(message, secrets ?? []));
}
