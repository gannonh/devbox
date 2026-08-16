import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { URL } from 'node:url';
import { normalizeGitHubRemote, normalizeBranch, type GitHubRemoteIdentity } from './identity.js';
import { shell, type ShellRunner } from '../../lib/shell.js';
import { redactSecrets } from './redaction.js';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface GitHubSourceRemote extends GitHubRemoteIdentity {
  url: string;
}

export const DEFAULT_VERCEL_SANDBOX_CWD = '/vercel/sandbox';

/**
 * Git sources are seeded by @vercel/sandbox below the session's default cwd
 * using the normalized repository name. Keep every command and terminal in
 * that same directory, including after a resumed session.
 */
export function resolveVercelRepositoryCwd(
  sandboxCwd: string | undefined,
  normalizedRepository: string,
): string {
  const repository = normalizedRepository.trim();
  if (!repository || repository.includes('/') || repository === '.' || repository === '..') {
    throw new Error('Vercel clone repository name must be normalized');
  }
  const base = sandboxCwd?.trim() || DEFAULT_VERCEL_SANDBOX_CWD;
  if (!base.startsWith('/')) throw new Error('Vercel Sandbox cwd must be absolute');
  return posix.join(base, repository);
}

export type GitHubSourceErrorCode =
  | 'github_origin_resolution_failed'
  | 'github_origin_invalid'
  | 'github_credentials_unavailable'
  | 'github_branch_invalid'
  | 'github_source_access_denied'
  | 'github_source_resolution_failed'
  | 'github_default_branch_unavailable'
  | 'github_branch_probe_failed';

export class GitHubSourceError extends Error {
  readonly operation = 'source' as const;
  readonly code: GitHubSourceErrorCode;
  readonly status?: number;

  constructor(code: GitHubSourceErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'GitHubSourceError';
    this.code = code;
    this.status = status;
  }
}

export interface GitSource {
  type: 'git';
  url: string;
  revision: string;
  username: 'x-access-token';
  password: string;
}

export interface GitHubSourcePlan {
  remote: GitHubSourceRemote;
  defaultBranch: string;
  requestedBranch: string;
  requestedBranchExists: boolean;
  needsBranchSetup: boolean;
  source: GitSource;
  warning: string;
}

export interface ResolveGitHubSourceOptions {
  repoRoot: string;
  branch: string;
  env?: Record<string, string | undefined>;
  shellRunner?: ShellRunner;
}

export interface ResolveGitHubTokenOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  shellRunner?: ShellRunner;
}

export interface ResolveGitHubSourceOriginOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  shellRunner?: ShellRunner;
}

/** Resolve only the local canonical GitHub origin; no remote branch or token query is made. */
export async function resolveGitHubSourceOrigin(
  options: ResolveGitHubSourceOriginOptions,
): Promise<GitHubSourceRemote> {
  const runner = options.shellRunner ?? shell;
  const knownSecrets = configuredTokenSecrets(options.env);
  let origin: string;
  try {
    origin = await runner.exec('git', ['remote', 'get-url', 'origin'], {
      cwd: options.repoRoot,
      silentStderr: true,
    });
  } catch (error) {
    throw createSourceError(
      'github_origin_resolution_failed',
      `Unable to resolve GitHub origin: ${errorMessage(error)}`,
      error,
      knownSecrets,
    );
  }

  try {
    return normalizeGitHubSourceRemote(origin);
  } catch (error) {
    throw createSourceError('github_origin_invalid', errorMessage(error), error, knownSecrets);
  }
}

/** Normalize an origin accepted by the remote-first GitHub provider. */
export function normalizeGitHubSourceRemote(remote: string): GitHubSourceRemote {
  const value = remote.trim();
  const lowerValue = value.toLowerCase();
  const isHttps = lowerValue.startsWith('https://');
  const isScpSsh = /^git@github\.com:/i.test(value);
  const isSshUrl = lowerValue.startsWith('ssh://');
  if (!isHttps && !isScpSsh && !isSshUrl) {
    throw new Error('GitHub origin must use HTTPS or SSH');
  }

  if (isHttps || isSshUrl) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new Error(`Invalid GitHub origin: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isHttps && parsed.protocol !== 'https:') {
      throw new Error('GitHub origin must use HTTPS or SSH');
    }
    if (isSshUrl && parsed.protocol !== 'ssh:') {
      throw new Error('GitHub origin must use HTTPS or SSH');
    }
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      throw new Error('GitHub origin must use github.com');
    }
    if (isHttps && (parsed.username || parsed.password)) {
      throw new Error('GitHub origin must not contain credentials');
    }
    if (isSshUrl && (parsed.username !== 'git' || parsed.password)) {
      throw new Error('GitHub SSH origin must use the git username without a password');
    }
    if (parsed.search || parsed.hash) {
      throw new Error('GitHub origin must not contain query or fragment components');
    }
    if (isHttps && parsed.port && parsed.port !== '443') {
      throw new Error('GitHub HTTPS origin must use the default port');
    }
    if (isSshUrl && parsed.port && parsed.port !== '22') {
      throw new Error('GitHub SSH origin must use the default port');
    }
  } else if (!/^git@github\.com:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/i.test(value)) {
    throw new Error('GitHub SCP origin contains reserved characters or an invalid path');
  }

  const identity = normalizeGitHubRemote(value);
  if (identity.host !== 'github.com') {
    throw new Error('GitHub origin must use github.com');
  }
  return {
    ...identity,
    url: `https://github.com/${identity.owner}/${identity.repository}.git`,
  };
}

export const REMOTE_SOURCE_WARNING =
  'Vercel uses the authenticated GitHub origin; local dirty files and unpushed commits are not copied to the cloud sandbox.';

export function renderRemoteSourceNotice(): string {
  return REMOTE_SOURCE_WARNING;
}

export async function resolveGitHubToken(options: ResolveGitHubTokenOptions): Promise<string> {
  const env = options.env ?? process.env;
  for (const value of [env.GH_TOKEN, env.GITHUB_TOKEN]) {
    if (!isNonEmpty(value)) continue;
    if (value.includes('\n') || value.includes('\r')) {
      throw new GitHubSourceError('github_credentials_unavailable', 'GitHub credential environment value must be single-line');
    }
    return value.trim();
  }

  const runner = options.shellRunner ?? shell;
  try {
    const token = await runner.exec('gh', ['auth', 'token'], {
      cwd: options.repoRoot,
      silentStderr: true,
    });
    if (!isNonEmpty(token) || token.includes('\n') || token.includes('\r')) {
      throw new GitHubSourceError('github_credentials_unavailable', 'gh auth token returned an empty or multi-line token');
    }
    return token.trim();
  } catch (error) {
    if (error instanceof GitHubSourceError) throw error;
    throw createSourceError(
      'github_credentials_unavailable',
      `Unable to resolve GitHub credentials: ${errorMessage(error)}`,
      error,
    );
  }
}

export async function resolveGitHubSource(
  options: ResolveGitHubSourceOptions,
): Promise<GitHubSourcePlan> {
  const runner = options.shellRunner ?? shell;
  const knownSecrets = configuredTokenSecrets(options.env);
  let requestedBranch: string;
  try {
    requestedBranch = normalizeRequestedSourceBranch(options.branch);
  } catch (error) {
    throw createSourceError('github_branch_invalid', errorMessage(error), error, knownSecrets);
  }
  let origin: string;
  try {
    origin = await runner.exec('git', ['remote', 'get-url', 'origin'], {
      cwd: options.repoRoot,
      silentStderr: true,
    });
  } catch (error) {
    throw createSourceError(
      'github_origin_resolution_failed',
      `Unable to resolve GitHub origin: ${errorMessage(error)}`,
      error,
      knownSecrets,
    );
  }

  let remote: GitHubSourceRemote;
  try {
    remote = normalizeGitHubSourceRemote(origin);
  } catch (error) {
    throw createSourceError('github_origin_invalid', errorMessage(error), error, knownSecrets);
  }

  const token = await resolveGitHubToken({
    repoRoot: options.repoRoot,
    env: options.env,
    shellRunner: runner,
  });
  const probeSecrets = [...new Set([...knownSecrets, token])];
  let defaultOutput: string;
  let branchResult: { stdout: string; code: number };
  try {
    ({ defaultOutput, branchResult } = await withGitAskPass(token, options.env, async (env) => {
      const probeOptions = { cwd: options.repoRoot, silentStderr: true, env };
      const defaultOutput = await runner.exec(
        'git',
        ['ls-remote', '--symref', remote.url, 'HEAD'],
        probeOptions,
      );
      const branchResult = await runner.execQuiet(
        'git',
        ['ls-remote', '--heads', remote.url, '--', `refs/heads/${requestedBranch}`],
        probeOptions,
      );
      return { defaultOutput, branchResult };
    }));
  } catch (error) {
    const status = statusOf(error);
    throw createSourceError(
      status === 401 || status === 403 ? 'github_source_access_denied' : 'github_source_resolution_failed',
      `Unable to resolve GitHub source branches: ${errorMessage(error)}`,
      error,
      probeSecrets,
      status,
    );
  }
  let defaultBranch: string;
  try {
    defaultBranch = parseRemoteDefaultBranch(defaultOutput);
  } catch (error) {
    throw createSourceError(
      'github_default_branch_unavailable',
      errorMessage(error),
      error,
      probeSecrets,
    );
  }
  if (branchResult.code !== 0) {
    throw createSourceError(
      'github_branch_probe_failed',
      `Unable to check the requested GitHub branch (git exited with code ${branchResult.code})`,
      undefined,
      probeSecrets,
    );
  }
  const requestedBranchExists = remoteBranchOutputContains(branchResult.stdout, requestedBranch);
  const selection = selectGitHubRevision({
    requestedBranch,
    defaultBranch,
    requestedBranchExists,
  });
  return {
    remote,
    defaultBranch: selection.defaultBranch,
    requestedBranch: selection.requestedBranch,
    requestedBranchExists,
    needsBranchSetup: selection.needsBranchSetup,
    source: {
      type: 'git',
      url: remote.url,
      revision: selection.revision,
      username: 'x-access-token',
      password: token,
    },
    warning: renderRemoteSourceNotice(),
  };
}

export function parseRemoteDefaultBranch(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const match = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/.exec(line.trim());
    if (match) return normalizeRequestedSourceBranch(match[1]);
  }
  throw new Error('GitHub origin did not report a default branch');
}

export function remoteBranchOutputContains(output: string, branch: string): boolean {
  const normalized = normalizeRequestedSourceBranch(branch);
  return output.split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 2 && fields[1] === `refs/heads/${normalized}`;
  });
}

const GIT_ASKPASS_SCRIPT = [
  '#!/bin/sh',
  'case "$1" in',
  '  *[Uu]sername*) printf \'%s\\n\' "${GIT_USERNAME:-x-access-token}" ;;',
  '  *) printf \'%s\\n\' "${GIT_PASSWORD:-}" ;;',
  'esac',
  '',
].join('\n');

async function withGitAskPass<T>(
  token: string,
  env: Record<string, string | undefined> | undefined,
  operation: (probeEnv: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'devbox-git-askpass-'));
  const helper = join(directory, 'askpass.sh');
  try {
    await chmod(directory, 0o700);
    const handle = await open(
      helper,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o700,
    );
    try {
      await handle.writeFile(GIT_ASKPASS_SCRIPT, 'utf8');
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    const probeEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(env ?? {}),
      GIT_ASKPASS: helper,
      GIT_TERMINAL_PROMPT: '0',
      GIT_USERNAME: 'x-access-token',
      GIT_PASSWORD: token,
    };
    delete probeEnv.GH_TOKEN;
    delete probeEnv.GITHUB_TOKEN;
    return await operation(probeEnv);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createSourceError(
  code: GitHubSourceErrorCode,
  message: string,
  cause?: unknown,
  secrets: readonly string[] = [],
  status?: number,
): GitHubSourceError {
  return new GitHubSourceError(
    code,
    redactSecrets(message, secrets),
    status ?? statusOf(cause),
  );
}

function statusOf(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown } } | null;
  if (typeof candidate?.status === 'number') return candidate.status;
  if (typeof candidate?.response?.status === 'number') return candidate.response.status;
  return undefined;
}

function configuredTokenSecrets(env: Record<string, string | undefined> | undefined): string[] {
  const values = env ?? process.env;
  return [values.GH_TOKEN, values.GITHUB_TOKEN]
    .filter((value): value is string => isNonEmpty(value));
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface GitHubRevisionSelection {
  revision: string;
  requestedBranch: string;
  defaultBranch: string;
  needsBranchSetup: boolean;
}

export function selectGitHubRevision(input: {
  requestedBranch: string;
  defaultBranch: string;
  requestedBranchExists: boolean;
}): GitHubRevisionSelection {
  const requestedBranch = normalizeRequestedSourceBranch(input.requestedBranch);
  const defaultBranch = normalizeRequestedSourceBranch(input.defaultBranch);
  return {
    revision: input.requestedBranchExists ? requestedBranch : defaultBranch,
    requestedBranch,
    defaultBranch,
    needsBranchSetup: !input.requestedBranchExists,
  };
}

export function normalizeRequestedSourceBranch(branch: string): string {
  const normalized = normalizeBranch(branch);
  if (
    normalized.startsWith('-') ||
    /[\s~^:?*]/.test(normalized) ||
    normalized.includes('[') ||
    normalized.includes(']') ||
    normalized.includes('\\') ||
    normalized.includes('..') ||
    normalized.split('/').some((segment) => segment === '.' || segment === '..' || segment.startsWith('.') || segment.endsWith('.')) ||
    normalized.includes('@{') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.endsWith('.') ||
    normalized.includes('//')
  ) {
    throw new Error('Git branch is not a valid remote branch name');
  }
  return normalized;
}
