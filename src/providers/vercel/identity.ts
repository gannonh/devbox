import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { URL } from 'node:url';

const MAX_VERCEL_NAME_LENGTH = 63;
const MAX_VERCEL_TAG_LENGTH = 63;
const PACKAGE = createRequire(import.meta.url)('../../../package.json') as { version?: unknown };

export interface GitHubRemoteIdentity {
  host: string;
  owner: string;
  repository: string;
  canonical: string;
}

export interface VercelIdentityInput {
  remote: string;
  branch: string;
  packageVersion?: string;
}

export interface VercelSandboxIdentity {
  provider: 'vercel';
  repository: GitHubRemoteIdentity;
  canonicalRepository: string;
  branch: string;
  packageVersion: string;
  name: string;
  tags: Readonly<Record<string, string>>;
}

export function normalizeGitHubRemote(remote: string): GitHubRemoteIdentity {
  const value = remote.trim();
  if (!value) throw new Error('GitHub remote must not be empty');

  let host: string;
  let repositoryPath: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new Error(`Invalid GitHub remote: ${error instanceof Error ? error.message : String(error)}`);
    }
    host = normalizeHost(parsed.hostname, parsed.port);
    repositoryPath = parsed.pathname;
  } else {
    const match = /^(?:[^@/]+@)?([^/:]+)(?::|\/)(.+)$/.exec(value);
    if (!match) throw new Error(`Invalid GitHub remote: ${remote}`);
    host = normalizeHost(match[1], '');
    repositoryPath = match[2];
  }

  let path: string;
  try {
    path = decodeURIComponent(repositoryPath);
  } catch (error) {
    throw new Error(`Invalid GitHub remote path: ${error instanceof Error ? error.message : String(error)}`);
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 2 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`GitHub remote must identify exactly an owner and repository: ${remote}`);
  }

  const owner = segments[0].toLowerCase();
  const repository = segments[1].toLowerCase();
  const canonical = `${host}/${owner}/${repository}`;
  return { host, owner, repository, canonical };
}

export function sanitizeVercelName(value: string, maxLength = MAX_VERCEL_NAME_LENGTH): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error('Vercel name maxLength must be a positive integer');
  }
  const sanitized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  const candidate = sanitized || 'devbox';
  const bounded = candidate.slice(0, maxLength).replace(/-+$/g, '');
  return bounded || 'd';
}

export function createVercelIdentity(input: VercelIdentityInput): VercelSandboxIdentity {
  const repository = normalizeGitHubRemote(input.remote);
  const branch = normalizeBranch(input.branch);
  const packageVersion = input.packageVersion ?? packageVersionFromPackage();
  if (!packageVersion.trim()) throw new Error('Package version must not be empty');

  const identitySource = [repository.canonical, branch, packageVersion].join('\0');
  const versionSlug = sanitizeVercelName(`v-${packageVersion}`);
  const humanName = [
    'devbox',
    'vercel',
    versionSlug,
    repository.host,
    repository.owner,
    repository.repository,
    branch,
  ].join('-');
  const name = appendHash(humanName, identitySource, MAX_VERCEL_NAME_LENGTH);
  const tags = {
    provider: 'vercel',
    repository: appendHash(
      `${repository.host}-${repository.owner}-${repository.repository}`,
      repository.canonical,
      MAX_VERCEL_TAG_LENGTH,
    ),
    branch: appendHash(branch, branch, MAX_VERCEL_TAG_LENGTH),
    version: appendHash(versionSlug, packageVersion, MAX_VERCEL_TAG_LENGTH),
    identity: hash(identitySource),
  } as const;

  return {
    provider: 'vercel',
    repository,
    canonicalRepository: repository.canonical,
    branch,
    packageVersion,
    name,
    tags,
  };
}

export function normalizeBranch(branch: string): string {
  let normalized = branch.trim();
  if (normalized.startsWith('refs/heads/')) normalized = normalized.slice('refs/heads/'.length);
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (!normalized || hasControlCharacter) {
    throw new Error('Git branch must be a non-empty printable string');
  }
  return normalized;
}

function normalizeHost(hostname: string, port: string): string {
  const host = hostname.toLowerCase().replace(/\.+$/g, '');
  if (!host || /[^a-z0-9.:-]/.test(host)) throw new Error('GitHub remote host is invalid');
  if (port && port !== '22' && port !== '80' && port !== '443') return `${host}:${port}`;
  return host;
}

function appendHash(value: string, source: string, maxLength: number): string {
  const suffix = `-${hash(source)}`;
  const available = maxLength - suffix.length;
  if (available <= 0) return hash(source).slice(0, maxLength);
  const prefix = sanitizeVercelName(value, available);
  return `${prefix}${suffix}`.slice(0, maxLength).replace(/-+$/g, '');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function packageVersionFromPackage(): string {
  if (typeof PACKAGE.version !== 'string' || !PACKAGE.version.trim()) {
    throw new Error('Package version is missing from package.json');
  }
  return PACKAGE.version;
}
