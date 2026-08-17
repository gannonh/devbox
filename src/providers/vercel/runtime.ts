import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Writable } from 'node:stream';
import { resolveDevboxEnv } from '../local/env.js';
import { redactSecrets } from './redaction.js';
import { collectPiBundle } from './pi-bundle.js';
import { startDisplayStack, VercelDisplayStartupError } from './display-startup.js';
import { launchBackgroundSetup, type VercelSetupStatus } from './setup.js';
import type { VercelBranchMetadataStore } from './metadata.js';
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
export const VERCEL_RUNTIME_ENV_PATH = `${VERCEL_SANDBOX_HOME}/.env`;
export const VERCEL_RUNTIME_GITHUB_TOKEN_PATH = `${VERCEL_RUNTIME_DIRECTORY}/github-token`;
export const VERCEL_GH_CONFIG_DIRECTORY = `${VERCEL_SANDBOX_HOME}/.config/gh`;
export const VERCEL_RUNTIME_PI_PATH = `${VERCEL_SANDBOX_HOME}/.pi`;

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
  shellRunner: ShellRunner;
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  stderr: Writable;
  hostHome?: string;
  piRoot?: string;
  signal?: AbortSignal;
  displayCredentialsStore?: VercelBranchMetadataStore;
  secrets?: string[];
}

export async function prepareSandboxRuntime(
  options: PrepareSandboxRuntimeOptions,
): Promise<VercelSetupStatus | null> {
  const hostEnvPath = resolveDevboxEnv(options.repoRoot, options.env, options.hostHome);
  let content: Buffer;
  try {
    content = await readFile(hostEnvPath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
    writeRuntimeWarning(
      options.stderr,
      `no .env at ${hostEnvPath} (set DEVBOX_ENV)`,
      runtimeEnvironmentSecrets(options.env),
    );
    content = Buffer.alloc(0);
  }
  const token = await resolveGitHubToken({
    repoRoot: options.repoRoot,
    env: options.env,
    shellRunner: options.shellRunner,
  });
  const secrets = options.secrets ?? [];
  addSecrets(secrets, token, ...runtimeEnvironmentSecrets(options.env), ...dotenvSecrets(content));
  const piBundle = await runRuntimeOperation('Pi config collection', secrets, () => collectPiBundle({
    ...(options.piRoot === undefined ? {} : { root: options.piRoot }),
    ...(options.hostHome === undefined ? {} : { home: options.hostHome }),
    env: options.env,
  }));
  const piRoot = options.piRoot
    ?? join(options.hostHome ?? options.env.HOME ?? process.env.HOME ?? '', '.pi');
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
    {
      path: VERCEL_RUNTIME_ENV_PATH,
      content,
      mode: 0o600,
    },
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
      'find /vercel/.pi -mindepth 1 -maxdepth 1 ! -name agent -exec rm -rf -- {} + '
        + '&& find /vercel/.pi/agent -mindepth 1 -maxdepth 1 ! -name sessions ! -name npm ! -name cache -exec rm -rf -- {} +',
    ],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, 'Pi config reconciliation', secrets);
  await uploadRuntimeFiles(options, files, secrets);
  try {
    await runRuntimeCommand(options, {
      cmd: 'sh',
      args: [
        '-c',
        'gh auth login --hostname github.com --with-token < /vercel/.devbox/runtime/github-token '
          + '&& gh auth setup-git --hostname github.com '
          + '&& rm -f /vercel/.devbox/runtime/github-token',
      ],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, 'GitHub auth setup', secrets);
  } catch (error) {
    await removeRuntimeGitHubToken(options, secrets);
    throw error;
  }
  await runRuntimeCommand(options, {
    cmd: 'sh',
    args: ['-c', 'if [ ! -e .env ]; then ln -s /vercel/.env .env; fi'],
    cwd: resolveVercelRepositoryCwd(options.sandbox.cwd, options.repository),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, 'workspace .env link', secrets);
  const displayCredentialsStore = options.displayCredentialsStore;
  if (displayCredentialsStore) {
    await runRuntimeOperation('Display startup', secrets, () => startDisplayStack({
      sandbox: options.sandbox,
      client: options.client,
      store: displayCredentialsStore,
      secrets,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  }
  return launchBackgroundSetup({
    sandbox: options.sandbox,
    client: options.client,
    workspace: resolveVercelRepositoryCwd(options.sandbox.cwd, options.repository),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
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
  } catch {
    throw new VercelRuntimeSyncError(redactSecrets('runtime file upload failed', secrets));
  }
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
    options.client.runCommand(options.sandbox, request));
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

function addSecrets(secrets: string[], ...values: Array<string | undefined>): void {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && !secrets.includes(value)) secrets.push(value);
  }
}

function runtimeEnvironmentSecrets(env: Record<string, string | undefined>): string[] {
  return ['GH_TOKEN', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN']
    .map((key) => env[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function dotenvSecrets(content: Buffer): string[] {
  const text = content.toString('utf8');
  return [
    text,
    ...text.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf('=');
      if (separator < 0) return [];
      const rawValue = line.slice(separator + 1).trim();
      const unquotedValue = rawValue.replace(/^(['"])(.*)\1$/, '$2');
      const value = unquotedValue === rawValue
        ? rawValue.replace(/ #.*$/, '')
        : unquotedValue;
      return [line, rawValue, value];
    }),
  ].filter((value) => value.length > 0);
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
