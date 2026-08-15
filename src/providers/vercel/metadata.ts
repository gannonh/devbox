import { randomUUID, createHash } from 'node:crypto';
import { open, lstat, mkdir, readFile, rename, unlink, chmod } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const APP_DIRECTORY = 'devbox';
const PROVIDERS_DIRECTORY = 'providers';

export interface VercelMetadataIdentity {
  name: string;
  repository: string;
  branch: string;
  packageVersion: string;
  tags: Record<string, string>;
}

export interface VercelResidualMetadata {
  sandboxIds?: string[];
  snapshotIds?: string[];
  reason?: string;
}

export interface VercelMetadataInput {
  teamId: string;
  projectId: string;
  identity?: VercelMetadataIdentity;
  sandboxId?: string;
  snapshotIds?: string[];
  residual?: VercelResidualMetadata;
}

export interface VercelMetadata extends VercelMetadataInput {
  schemaVersion: 1;
  provider: string;
  repoKeyHash: string;
}

export interface VercelMetadataStoreOptions {
  repoKey: string;
  provider?: string;
  stateHome?: string;
}

export interface MetadataLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface MetadataLockOptions {
  timeoutMs?: number;
  retryMs?: number;
}

export interface VercelMetadataStore {
  readonly path: string;
  readonly lockPath: string;
  read(): Promise<VercelMetadata | null>;
  write(metadata: VercelMetadataInput): Promise<void>;
  remove(): Promise<void>;
  acquireLock(options?: MetadataLockOptions): Promise<MetadataLock>;
  withLock<T>(operation: () => Promise<T>, options?: MetadataLockOptions): Promise<T>;
}

export function createVercelMetadataStore(
  options: VercelMetadataStoreOptions,
): VercelMetadataStore {
  const provider = options.provider ?? 'vercel';
  validatePathComponent(provider, 'provider');
  if (!options.repoKey) {
    throw new Error('Metadata repoKey must not be empty');
  }

  const stateHome = options.stateHome || process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const repoKeyHash = createHash('sha256')
    .update(`${provider}\0${options.repoKey}`)
    .digest('hex');
  const directory = join(stateHome, APP_DIRECTORY, PROVIDERS_DIRECTORY, provider);
  const pathname = join(directory, `${repoKeyHash}.json`);
  const lockPath = join(directory, `${repoKeyHash}.lock`);

  return {
    path: pathname,
    lockPath,
    read: async () => readMetadata(pathname),
    write: async (metadata) => writeMetadata(pathname, directory, {
      ...metadata,
      schemaVersion: 1,
      provider,
      repoKeyHash,
    }),
    remove: async () => {
      await assertSecureFileIfPresent(pathname, 'metadata');
      try {
        await unlink(pathname);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    },
    acquireLock: (lockOptions) => acquireMetadataLock(directory, lockPath, lockOptions),
    withLock: async <T>(operation: () => Promise<T>, lockOptions?: MetadataLockOptions) => {
      const lock = await acquireMetadataLock(directory, lockPath, lockOptions);
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    },
  };
}

async function readMetadata(pathname: string): Promise<VercelMetadata | null> {
  await assertSecureFileIfPresent(pathname, 'metadata');
  let content: string;
  try {
    content = await readFile(pathname, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Malformed Vercel metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseMetadata(parsed);
}

async function writeMetadata(
  pathname: string,
  directory: string,
  metadata: VercelMetadata,
): Promise<void> {
  validateMetadataInput(metadata);
  await ensurePrivateDirectory(directory);
  await assertSecureFileIfPresent(pathname, 'metadata');

  const content = JSON.stringify(serializeMetadata(metadata)) + '\n';
  const temporaryPath = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    handle = await open(temporaryPath, 'wx', FILE_MODE);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, pathname);
    await chmod(pathname, FILE_MODE);
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) failure ??= error;
  }
  if (failure) throw failure;
}

async function acquireMetadataLock(
  directory: string,
  lockPath: string,
  options: MetadataLockOptions = {},
): Promise<MetadataLock> {
  await ensurePrivateDirectory(directory);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 25;
  const startedAt = Date.now();
  const owner = `${process.pid}:${randomUUID()}`;
  let handle: FileHandle | undefined;

  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', FILE_MODE);
      await handle.writeFile(owner, 'utf8');
      await handle.sync();
    } catch (error) {
      if (handle) await handle.close();
      handle = undefined;
      if (!isNodeError(error, 'EEXIST')) throw error;
      await assertSecureFileIfPresent(lockPath, 'metadata lock');
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Vercel metadata lock: ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }

  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) return;
      released = true;
      await handle?.close();
      try {
        const currentOwner = await readFile(lockPath, 'utf8');
        if (currentOwner === owner) await unlink(lockPath);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    },
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const stats = await lstat(directory);
  if (!stats.isDirectory()) throw new Error(`Metadata path is not a directory: ${directory}`);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`Insecure metadata directory mode for ${directory}; expected private access`);
  }
  await chmod(directory, DIRECTORY_MODE);
}

async function assertSecureFileIfPresent(pathname: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(pathname);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${label} path is not a regular file: ${pathname}`);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`Insecure ${label} mode for ${pathname}; expected owner-only access`);
  }
}

function serializeMetadata(metadata: VercelMetadata): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    schemaVersion: 1,
    provider: metadata.provider,
    repoKeyHash: metadata.repoKeyHash,
    teamId: metadata.teamId,
    projectId: metadata.projectId,
  };
  if (metadata.identity) {
    serialized.identity = {
      name: metadata.identity.name,
      repository: metadata.identity.repository,
      branch: metadata.identity.branch,
      packageVersion: metadata.identity.packageVersion,
      tags: { ...metadata.identity.tags },
    };
  }
  if (metadata.sandboxId !== undefined) serialized.sandboxId = metadata.sandboxId;
  if (metadata.snapshotIds !== undefined) serialized.snapshotIds = [...metadata.snapshotIds];
  if (metadata.residual !== undefined) {
    serialized.residual = {
      ...(metadata.residual.sandboxIds ? { sandboxIds: [...metadata.residual.sandboxIds] } : {}),
      ...(metadata.residual.snapshotIds ? { snapshotIds: [...metadata.residual.snapshotIds] } : {}),
      ...(metadata.residual.reason !== undefined ? { reason: metadata.residual.reason } : {}),
    };
  }
  return serialized;
}

function parseMetadata(value: unknown): VercelMetadata {
  if (!isRecord(value)) throw new Error('Malformed Vercel metadata: expected an object');
  if (
    value.schemaVersion !== 1 ||
    typeof value.provider !== 'string' ||
    typeof value.repoKeyHash !== 'string' ||
    typeof value.teamId !== 'string' ||
    typeof value.projectId !== 'string'
  ) {
    throw new Error('Malformed Vercel metadata: missing required non-secret fields');
  }
  const metadata: VercelMetadata = {
    schemaVersion: 1,
    provider: requireString(value.provider, 'provider'),
    repoKeyHash: requireString(value.repoKeyHash, 'repoKeyHash'),
    teamId: requireString(value.teamId, 'teamId'),
    projectId: requireString(value.projectId, 'projectId'),
  };
  if (value.identity !== undefined) metadata.identity = parseIdentity(value.identity);
  if (value.sandboxId !== undefined) metadata.sandboxId = requireString(value.sandboxId, 'sandboxId');
  if (value.snapshotIds !== undefined) metadata.snapshotIds = requireStringArray(value.snapshotIds, 'snapshotIds');
  if (value.residual !== undefined) metadata.residual = parseResidual(value.residual);
  return metadata;
}

function parseIdentity(value: unknown): VercelMetadataIdentity {
  if (!isRecord(value)) throw new Error('Malformed Vercel metadata identity');
  const tags = value.tags;
  if (!isRecord(tags) || Object.keys(tags).length > 5) {
    throw new Error('Malformed Vercel metadata identity tags');
  }
  const parsedTags: Record<string, string> = {};
  for (const [key, tag] of Object.entries(tags)) parsedTags[key] = requireString(tag, `identity.tags.${key}`);
  return {
    name: requireString(value.name, 'identity.name'),
    repository: requireString(value.repository, 'identity.repository'),
    branch: requireString(value.branch, 'identity.branch'),
    packageVersion: requireString(value.packageVersion, 'identity.packageVersion'),
    tags: parsedTags,
  };
}

function parseResidual(value: unknown): VercelResidualMetadata {
  if (!isRecord(value)) throw new Error('Malformed Vercel metadata residual');
  const residual: VercelResidualMetadata = {};
  if (value.sandboxIds !== undefined) residual.sandboxIds = requireStringArray(value.sandboxIds, 'residual.sandboxIds');
  if (value.snapshotIds !== undefined) residual.snapshotIds = requireStringArray(value.snapshotIds, 'residual.snapshotIds');
  if (value.reason !== undefined) residual.reason = requireString(value.reason, 'residual.reason');
  return residual;
}

function validateMetadataInput(metadata: VercelMetadata): void {
  requireString(metadata.teamId, 'teamId');
  requireString(metadata.projectId, 'projectId');
  requireString(metadata.provider, 'provider');
  requireString(metadata.repoKeyHash, 'repoKeyHash');
  if (metadata.identity) parseIdentity(serializeMetadata({ ...metadata }).identity);
  if (metadata.sandboxId !== undefined) requireString(metadata.sandboxId, 'sandboxId');
  if (metadata.snapshotIds !== undefined) requireStringArray(metadata.snapshotIds, 'snapshotIds');
  if (metadata.residual !== undefined) parseResidual(metadata.residual);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Metadata ${field} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Metadata ${field} must be an array`);
  return value.map((entry) => requireString(entry, field));
}

function validatePathComponent(value: string, field: string): void {
  if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error(`Metadata ${field} contains unsupported characters`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
