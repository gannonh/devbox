import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { assertSafeEnvironmentKeys, readEnvironmentFile } from '../local/env.js';
import { addSecrets, redactSecrets } from './redaction.js';
import { collectPiBundle } from './pi-bundle.js';
import {
  isDisplayStackRunning,
  startDisplayStack,
  VercelDisplayStartupError,
} from './display-startup.js';
import { launchBackgroundSetup, type VercelSetupStatus } from './setup.js';
import {
  currentVercelSessionId,
  type VercelSessionId,
} from './session-lease.js';
import type { VercelBranchMetadataStore } from './metadata.js';
import { parseVercelImageReference } from './image.js';
import type { ShellRunner } from '../../lib/shell.js';
import {
  resolveGitHubToken,
  resolveVercelRepositoryCwd,
} from './source.js';
import type {
  VercelSandboxClient,
  VercelSandboxHandle,
} from './client.js';

export const VERCEL_SANDBOX_HOME = '/vercel';
export const VERCEL_RUNTIME_DIRECTORY = `${VERCEL_SANDBOX_HOME}/.devbox/runtime`;
export const VERCEL_RUNTIME_ENV_STATE_PATH = `${VERCEL_RUNTIME_DIRECTORY}/environment.json`;
export const VERCEL_RUNTIME_GITHUB_TOKEN_PATH = `${VERCEL_RUNTIME_DIRECTORY}/github-token`;
export const VERCEL_GH_CONFIG_DIRECTORY = `${VERCEL_SANDBOX_HOME}/.config/gh`;
export const VERCEL_RUNTIME_PI_PATH = `${VERCEL_SANDBOX_HOME}/.pi`;
export const VERCEL_RUNTIME_PREPARATION_PATH = `${VERCEL_RUNTIME_DIRECTORY}/preparation.json`;
export const RUNTIME_PREPARATION_TIMEOUT_MS = 5 * 60 * 1000;

const PREPARATION_EVIDENCE_SENTINEL = '--DEVBOX--';

/** Positive evidence that this Sandbox instance has a reusable runtime state. */
export interface RuntimePreparationBase {
  sandboxName: string;
  sourceRevision: string;
  imageDigest: string;
  githubTokenSha256: string;
  envSha256: string;
}

export type RuntimePreparationMarker = RuntimePreparationBase & {
  sessionId: VercelSessionId;
};

export interface RuntimePreparationActualEvidence extends RuntimePreparationBase {
  sessionId: VercelSessionId;
  sourceSnapshotId?: string;
}

export type RuntimePreparationActual = RuntimePreparationActualEvidence;

export type RuntimeVmSession =
  | { kind: 'new'; sessionId: VercelSessionId }
  | { kind: 'same-session'; sessionId: VercelSessionId }
  | { kind: 'snapshot-resumed'; sessionId: VercelSessionId; sourceSnapshotId: string };

export type RuntimePreparationEvidenceKind =
  | 'full'
  | 'running-session'
  | 'running-sync'
  | 'snapshot'
  | 'snapshot-sync';

export interface PreparedSandboxRuntime {
  setupStatus: VercelSetupStatus | null;
  /** True when evidence proved the box already prepared and work was skipped. */
  reused: boolean;
  evidence: RuntimePreparationEvidenceKind;
  /** True when the current SDK session was created from a retained snapshot. */
  snapshotResumed: boolean;
}

export class VercelRuntimeSyncError extends Error {
  readonly code = 'runtime_sync_failed';

  constructor(message: string) {
    super(message);
    this.name = 'VercelRuntimeSyncError';
  }
}

export interface PrepareSandboxRuntimeOptions {
  repoRoot: string;
  repository: string;
  env: Record<string, string | undefined>;
  envPath?: string;
  runtimeEnvironment?: Record<string, string>;
  shellRunner: ShellRunner;
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  stderr: Writable;
  hostHome?: string;
  piRoot?: string;
  signal?: AbortSignal;
  displayCredentialsStore?: VercelBranchMetadataStore;
  secrets?: string[];
  /** `attach` attempts an evidence-backed skip before full preparation. */
  mode?: 'boot' | 'attach';
}

/**
 * Reuse is only correct with positive evidence tied to this Sandbox instance
 * or to a retained snapshot at an unchanged HEAD. Any absent, unreadable, or
 * stale stable field means full preparation. A rotated host `.env` or GitHub
 * token takes the runtime-sync path so secrets are refreshed without trusting
 * stale checkout evidence.
 */
export function evaluatePreparation(
  marker: unknown,
  actual: RuntimePreparationActual,
): boolean {
  if (!hasPreparationMarker(marker)) return false;
  return classifyRuntimeVmSession(marker, actual).kind === 'same-session'
    && marker.sourceRevision === actual.sourceRevision
    && marker.imageDigest === actual.imageDigest
    && marker.githubTokenSha256 === actual.githubTokenSha256
    && marker.envSha256 === actual.envSha256;
}

/**
 * Classify the VM before considering hashes or snapshot metadata.
 *
 * A matching preparation session is the only same-session proof. A different
 * marker session plus a provider source snapshot is a snapshot resume, even
 * when runtime files need refreshing afterward.
 */
export function classifyRuntimeVmSession(
  marker: unknown,
  actual: RuntimePreparationActualEvidence,
): RuntimeVmSession {
  if (!hasPreparationMarker(marker)) return { kind: 'new', sessionId: actual.sessionId };
  if (marker.sessionId === actual.sessionId) {
    return { kind: 'same-session', sessionId: actual.sessionId };
  }
  if (actual.sourceSnapshotId !== undefined) {
    return {
      kind: 'snapshot-resumed',
      sessionId: actual.sessionId,
      sourceSnapshotId: actual.sourceSnapshotId,
    };
  }
  return { kind: 'new', sessionId: actual.sessionId };
}

/** Classify the evidence before deciding which preparation work is safe. */
export function classifyPreparation(
  marker: unknown,
  actual: RuntimePreparationActualEvidence,
): RuntimePreparationEvidenceKind {
  const vmSession = classifyRuntimeVmSession(marker, actual);
  if (vmSession.kind === 'new') return 'full';
  if (!hasPreparationMarker(marker)) return 'full';
  const stable = marker.sandboxName === actual.sandboxName
    && marker.sourceRevision === actual.sourceRevision
    && marker.imageDigest === actual.imageDigest;
  if (!stable) return vmSession.kind === 'snapshot-resumed' ? 'snapshot' : 'full';
  const hashesMatch = marker.githubTokenSha256 === actual.githubTokenSha256
    && marker.envSha256 === actual.envSha256;
  if (vmSession.kind === 'snapshot-resumed') return hashesMatch ? 'snapshot' : 'snapshot-sync';
  return hashesMatch ? 'running-session' : 'running-sync';
}

function hasPreparationMarker(value: unknown): value is RuntimePreparationMarker {
  if (!isRecord(value)) return false;
  return typeof value.sandboxName === 'string'
    && typeof value.sourceRevision === 'string'
    && typeof value.imageDigest === 'string'
    && typeof value.githubTokenSha256 === 'string'
    && typeof value.envSha256 === 'string'
    && typeof value.sessionId === 'string'
    && value.sessionId.trim() !== '';
}

function environmentStateHash(environment: Record<string, string>): string {
  // JSON encoding keeps the hash injective; dotenv values may contain newlines.
  const canonical = JSON.stringify(Object.keys(environment).sort()
    .map((key) => [key, environment[key]]));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

interface PreparationEvidence {
  marker: unknown;
  revision: string;
}

async function readPreparationEvidence(
  options: PrepareSandboxRuntimeOptions,
): Promise<PreparationEvidence | null> {
  const workspace = resolveVercelRepositoryCwd(options.sandbox.cwd, options.repository);
  let output: string;
  try {
    const result = await options.client.runCommand(options.sandbox, {
      cmd: 'sh',
      args: [
        '-c',
        `cat ${VERCEL_RUNTIME_PREPARATION_PATH} 2>/dev/null; printf '\\n${PREPARATION_EVIDENCE_SENTINEL}\\n'; `
          + `git -C ${workspace} rev-parse HEAD`,
      ],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.exitCode !== 0 || !result.stdout) return null;
    output = await result.stdout(
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch {
    return null;
  }
  const splitAt = output.indexOf(`\n${PREPARATION_EVIDENCE_SENTINEL}\n`);
  if (splitAt < 0) return null;
  const revision = output.slice(splitAt + PREPARATION_EVIDENCE_SENTINEL.length + 2).trim();
  if (!revision) return null;
  try {
    return { marker: JSON.parse(output.slice(0, splitAt)), revision };
  } catch {
    return null;
  }
}

async function reusePreparedRuntime(
  options: PrepareSandboxRuntimeOptions,
  secrets: string[],
): Promise<PreparedSandboxRuntime> {
  const store = options.displayCredentialsStore;
  if (store && !await isDisplayStackRunning({ sandbox: options.sandbox, client: options.client })) {
    await runRuntimeOperation('Display startup', secrets, () => startDisplayStack({
      sandbox: options.sandbox,
      client: options.client,
      store,
      secrets,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  }
  // Reconciles background setup through the same routine as the full path: a
  // failed or vanished run is relaunched, a succeeded or live run is reported.
  const setupStatus = await runRuntimeOperation('Background setup', secrets, () => launchBackgroundSetup({
    sandbox: options.sandbox,
    client: options.client,
    workspace: resolveVercelRepositoryCwd(options.sandbox.cwd, options.repository),
    ...(options.runtimeEnvironment === undefined ? {} : { env: options.runtimeEnvironment }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }));
  return {
    setupStatus,
    reused: true,
    evidence: 'running-session',
    snapshotResumed: false,
  };
}

export async function prepareSandboxRuntime(
  options: PrepareSandboxRuntimeOptions,
): Promise<PreparedSandboxRuntime> {
  const runtimeEnvironment = await resolveRuntimeEnvironment(options);
  assertSafeEnvironmentKeys(runtimeEnvironment);
  options.runtimeEnvironment = runtimeEnvironment;
  const token = await resolveGitHubToken({
    repoRoot: options.repoRoot,
    env: options.env,
    shellRunner: options.shellRunner,
  });
  const secrets = options.secrets ?? [];
  addSecrets(
    secrets,
    token,
    ...runtimeEnvironmentSecrets(options.env),
    ...Object.values(runtimeEnvironment),
  );
  const githubTokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const environmentHash = environmentStateHash(runtimeEnvironment);
  if (options.mode === 'attach' || options.mode === 'boot') {
    const evidence = await readPreparationEvidence(options);
    if (evidence !== null) {
      const sessionId = currentVercelSessionId(options.sandbox);
      if (sessionId) {
        const actual: RuntimePreparationActualEvidence = {
          sandboxName: options.sandbox.name,
          sessionId,
          sourceRevision: evidence.revision,
          imageDigest: sandboxImageDigest(options.sandbox),
          githubTokenSha256: githubTokenHash,
          envSha256: environmentHash,
          ...(options.sandbox.sourceSnapshotId === undefined
            ? {}
            : { sourceSnapshotId: options.sandbox.sourceSnapshotId }),
        };
        const evidenceKind = classifyPreparation(evidence.marker, actual);
        if (evidenceKind === 'running-session') return reusePreparedRuntime(options, secrets);
        if (evidenceKind === 'running-sync' || evidenceKind === 'snapshot' || evidenceKind === 'snapshot-sync') {
        await synchronizeRuntimeState(options, token, secrets, evidenceKind === 'snapshot' || evidenceKind === 'snapshot-sync');
        // Same relaunch semantics as reusePreparedRuntime: a snapshot can retain
        // setup.status=running after --pause killed the setup PID. Verify/restart.
        const setupStatus = await runRuntimeOperation('Background setup', secrets, () => launchBackgroundSetup({
          sandbox: options.sandbox,
          client: options.client,
          workspace: resolveVercelRepositoryCwd(options.sandbox.cwd, options.repository),
          ...(options.runtimeEnvironment === undefined ? {} : { env: options.runtimeEnvironment }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }));
        await writePreparationMarker(options, secrets, {
          sandboxName: options.sandbox.name,
          sessionId: actual.sessionId,
          sourceRevision: actual.sourceRevision,
          imageDigest: actual.imageDigest,
          githubTokenSha256: githubTokenHash,
          envSha256: environmentHash,
        });
        return {
          setupStatus,
          reused: true,
          evidence: evidenceKind,
          snapshotResumed: evidenceKind === 'snapshot' || evidenceKind === 'snapshot-sync',
        };
        }
      }
    }
  }
  await synchronizeRuntimeState(options, token, secrets, true);
  const revision = await readRemoteRevision(options);
  const setupStatus = await runRuntimeOperation('Background setup', secrets, () => launchBackgroundSetup({
    sandbox: options.sandbox,
    client: options.client,
    workspace: resolveVercelRepositoryCwd(options.sandbox.cwd, options.repository),
    ...(options.runtimeEnvironment === undefined ? {} : { env: options.runtimeEnvironment }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }));
  const sessionId = currentVercelSessionId(options.sandbox);
  if (revision !== undefined && sessionId !== null) {
    // Written last: moving it earlier would let a crash mid-preparation fake evidence.
    await writePreparationMarker(options, secrets, {
      sandboxName: options.sandbox.name,
      sessionId,
      sourceRevision: revision,
      imageDigest: sandboxImageDigest(options.sandbox),
      githubTokenSha256: githubTokenHash,
      envSha256: environmentHash,
    });
  }
  return { setupStatus, reused: false, evidence: 'full', snapshotResumed: false };
}

async function synchronizeRuntimeState(
  options: PrepareSandboxRuntimeOptions,
  token: string,
  secrets: string[],
  restartDisplay: boolean,
): Promise<void> {
  const piBundle = await runRuntimeOperation('Pi config collection', secrets, () => collectPiBundle({
    ...(options.piRoot === undefined ? {} : { root: options.piRoot }),
    ...(options.hostHome === undefined ? {} : { home: options.hostHome }),
    env: options.env,
  }));
  const piHome = options.hostHome ?? options.env.HOME;
  const piRoot = options.piRoot ?? (piHome === undefined ? '<unknown>' : join(piHome, '.pi'));
  if (piBundle.rootMissing) {
    writeRuntimeWarning(options.stderr, `Pi config root missing at ${piRoot}; continuing`, secrets);
  }
  for (const skipped of piBundle.skipped) {
    writeRuntimeWarning(options.stderr, `Pi config skipped ${skipped.path}: ${skipped.reason}`, secrets);
  }
  if (piBundle.skippedCount > piBundle.skipped.length) {
    writeRuntimeWarning(
      options.stderr,
      `Pi config skipped ${piBundle.skippedCount - piBundle.skipped.length} additional path(s)`,
      secrets,
    );
  }
  const files = [
    ...(options.envPath === undefined ? [] : [{
      path: VERCEL_RUNTIME_ENV_STATE_PATH,
      content: Buffer.from(JSON.stringify(options.runtimeEnvironment ?? {})),
      mode: 0o600,
    }]),
    {
      path: VERCEL_RUNTIME_GITHUB_TOKEN_PATH,
      content: Buffer.from(token),
      mode: 0o600,
    },
    ...piBundle.entries.map((entry) => ({
      path: `${VERCEL_RUNTIME_PI_PATH}/${entry.path}`,
      content: entry.content,
      mode: entry.mode & ~0o022,
    })),
  ];
  const directories = runtimeDirectories(files.map((file) => file.path));
  await runRuntimeCommand(options, {
    cmd: 'mkdir',
    args: ['-p', ...directories],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, 'runtime directory creation', secrets);
  await runRuntimeCommand(options, {
    cmd: 'chmod',
    args: ['700', ...directories],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, 'runtime directory permissions', secrets);
  await runRuntimeCommand(options, {
    cmd: 'sh',
    args: [
      '-c',
      `find ${VERCEL_RUNTIME_PI_PATH} -mindepth 1 -maxdepth 1 ! -name agent -exec rm -rf -- {} + `
        + `&& find ${VERCEL_RUNTIME_PI_PATH}/agent -mindepth 1 -maxdepth 1 ! -name sessions ! -name npm ! -name cache ! -name fff -exec rm -rf -- {} +`,
    ],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, 'Pi config reconciliation', secrets);
  await uploadRuntimeFiles(options, files, secrets);
  try {
    await runRuntimeCommand(options, {
      cmd: 'sh',
      args: [
        '-c',
        `gh auth login --hostname github.com --with-token < ${VERCEL_RUNTIME_GITHUB_TOKEN_PATH} `
          + '&& gh auth setup-git --hostname github.com '
          + `&& rm -f ${VERCEL_RUNTIME_GITHUB_TOKEN_PATH}`,
      ],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, 'GitHub auth setup', secrets);
  } catch (error) {
    await removeRuntimeGitHubToken(options, secrets);
    throw error;
  }
  const displayCredentialsStore = options.displayCredentialsStore;
  if (displayCredentialsStore && (restartDisplay || !await isDisplayStackRunning({
    sandbox: options.sandbox,
    client: options.client,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }))) {
    // Display services need the image's base environment; project dotenv values
    // belong to the terminal and background setup commands below.
    await runRuntimeOperation('Display startup', secrets, () => startDisplayStack({
      sandbox: options.sandbox,
      client: options.client,
      store: displayCredentialsStore,
      secrets,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  }
}

async function writePreparationMarker(
  options: PrepareSandboxRuntimeOptions,
  secrets: readonly string[],
  marker: RuntimePreparationMarker,
): Promise<void> {
  await uploadRuntimeFiles(options, [{
    path: VERCEL_RUNTIME_PREPARATION_PATH,
    content: Buffer.from(JSON.stringify(marker)),
    mode: 0o600,
  }], secrets);
}

function sandboxImageDigest(sandbox: VercelSandboxHandle): string {
  if (sandbox.image === undefined) return '';
  try {
    return parseVercelImageReference(sandbox.image).digest;
  } catch {
    return '';
  }
}

async function readRemoteRevision(
  options: PrepareSandboxRuntimeOptions,
): Promise<string | undefined> {
  try {
    const result = await options.client.runCommand(options.sandbox, {
      cmd: 'git',
      args: ['-C', resolveVercelRepositoryCwd(options.sandbox.cwd, options.repository), 'rev-parse', 'HEAD'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.exitCode !== 0 || !result.stdout) return undefined;
    return (await result.stdout(
      options.signal === undefined ? undefined : { signal: options.signal },
    )).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function resolveRuntimeEnvironment(
  options: PrepareSandboxRuntimeOptions,
): Promise<Record<string, string>> {
  if (options.runtimeEnvironment !== undefined) return options.runtimeEnvironment;
  if (options.envPath !== undefined) {
    try {
      return await readEnvironmentFile(options.envPath);
    } catch (error) {
      throw new VercelRuntimeSyncError(error instanceof Error ? error.message : String(error));
    }
  }

  let result: Awaited<ReturnType<VercelSandboxClient['runCommand']>>;
  try {
    result = await options.client.runCommand(options.sandbox, {
      cmd: 'sh',
      args: ['-c', `if [ -f ${VERCEL_RUNTIME_ENV_STATE_PATH} ]; then cat ${VERCEL_RUNTIME_ENV_STATE_PATH}; else printf '{}'; fi`],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new VercelRuntimeSyncError(`runtime environment state read failed: ${String(error)}`);
  }
  if (result.exitCode !== 0 || !result.stdout) return {};

  try {
    const value: unknown = JSON.parse(await result.stdout(
      options.signal === undefined ? undefined : { signal: options.signal },
    ));
    if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
      throw new Error('invalid environment state');
    }
    return value as Record<string, string>;
  } catch {
    throw new VercelRuntimeSyncError('runtime environment state is invalid');
  }
}

function withRuntimeEnvironment(
  options: PrepareSandboxRuntimeOptions,
  request: Parameters<VercelSandboxClient['runCommand']>[1],
): Parameters<VercelSandboxClient['runCommand']>[1] {
  const values = options.runtimeEnvironment;
  if (values === undefined) return request;
  return { ...request, env: { ...values, ...(request.env ?? {}) } };
}

async function uploadRuntimeFiles(
  options: PrepareSandboxRuntimeOptions,
  files: Array<{ path: string; content: Buffer; mode: number }>,
  secrets: readonly string[],
): Promise<void> {
  try {
    await options.client.writeFiles(
      options.sandbox,
      files,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    throw new VercelRuntimeSyncError(
      `runtime file upload failed: ${runtimeUploadErrorDetail(error, secrets)}`,
    );
  }
}

function runtimeUploadErrorDetail(error: unknown, secrets: readonly string[]): string {
  // SDK upload errors may echo uploaded file contents; keep safe structured fields only.
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const candidate = error as {
    operation?: unknown;
    status?: unknown;
    code?: unknown;
    path?: unknown;
  };
  const details = [
    typeof candidate.operation === 'string' ? candidate.operation : undefined,
    typeof candidate.status === 'number' ? `status ${candidate.status}` : undefined,
    typeof candidate.code === 'string' ? candidate.code : undefined,
    typeof candidate.path === 'string' ? candidate.path : undefined,
  ].filter((value): value is string => value !== undefined);
  return details.length === 0 ? 'unknown error' : redactSecrets(details.join(', '), secrets);
}

async function runRuntimeOperation<T>(
  operation: string,
  secrets: readonly string[],
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof VercelDisplayStartupError) throw error;
    throw new VercelRuntimeSyncError(`${operation} failed: ${redactSecrets(error, secrets)}`);
  }
}

async function removeRuntimeGitHubToken(
  options: PrepareSandboxRuntimeOptions,
  secrets: readonly string[],
): Promise<void> {
  try {
    await runRuntimeCommand(options, {
      cmd: 'sh',
      args: ['-c', `rm -f ${VERCEL_RUNTIME_GITHUB_TOKEN_PATH}`],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, 'GitHub token cleanup', secrets);
  } catch {
    // Best effort: the next sync overwrites the fixed path before auth retries.
  }
}

async function runRuntimeCommand(
  options: PrepareSandboxRuntimeOptions,
  request: Parameters<VercelSandboxClient['runCommand']>[1],
  operation: string,
  secrets: readonly string[],
): Promise<void> {
  const result = await runRuntimeOperation(operation, secrets, () =>
    options.client.runCommand(options.sandbox, withRuntimeEnvironment(options, request)));
  const output = await runRuntimeOperation(`${operation} output`, secrets, async () => {
    const parts: string[] = [];
    if (result.stdout) parts.push(await result.stdout(options.signal === undefined ? undefined : { signal: options.signal }));
    if (result.stderr) parts.push(await result.stderr(options.signal === undefined ? undefined : { signal: options.signal }));
    return redactSecrets(parts.join('\n').trim(), secrets);
  });
  if (result.exitCode !== 0) {
    throw new VercelRuntimeSyncError(
      `${operation} failed${output ? `: ${output}` : ` with exit code ${result.exitCode}`}`,
    );
  }
}

function runtimeEnvironmentSecrets(env: Record<string, string | undefined>): string[] {
  return ['GH_TOKEN', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN']
    .map((key) => env[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimeDirectories(paths: readonly string[]): string[] {
  const directories = new Set([
    `${VERCEL_SANDBOX_HOME}/.devbox`,
    VERCEL_RUNTIME_DIRECTORY,
    `${VERCEL_SANDBOX_HOME}/.config`,
    VERCEL_GH_CONFIG_DIRECTORY,
    VERCEL_RUNTIME_PI_PATH,
    `${VERCEL_RUNTIME_PI_PATH}/agent`,
  ]);
  for (const pathname of paths) {
    const parents: string[] = [];
    for (
      let directory = posix.dirname(pathname);
      directory !== VERCEL_SANDBOX_HOME && directory.startsWith(`${VERCEL_SANDBOX_HOME}/`);
      directory = posix.dirname(directory)
    ) {
      parents.push(directory);
    }
    for (const directory of parents.reverse()) directories.add(directory);
  }
  return [...directories];
}

function writeRuntimeWarning(
  stderr: Writable,
  message: string,
  secrets: readonly string[],
): void {
  stderr.write(`${redactSecrets(message, secrets)}\n`);
}
