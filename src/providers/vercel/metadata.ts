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

export interface MetadataLockOwner {
  pid: number;
  id: string;
  acquiredAt: number;
}

export type MetadataLockOwnerWriter = (
  handle: FileHandle,
  owner: MetadataLockOwner,
) => Promise<void>;

export interface MetadataLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleLockMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  ownerWriter?: MetadataLockOwnerWriter;
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
    read: async () => readMetadata(pathname, provider, repoKeyHash),
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

async function readMetadata(
  pathname: string,
  expectedProvider: string,
  expectedRepoKeyHash: string,
): Promise<VercelMetadata | null> {
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
  return parseMetadata(parsed, expectedProvider, expectedRepoKeyHash);
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
  const staleLockMs = options.staleLockMs ?? 30_000;
  const now = options.now ?? Date.now;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const ownerWriter = options.ownerWriter ?? writeLockOwner;
  const startedAt = now();
  validateDuration(timeoutMs, 'timeoutMs');
  validateDuration(retryMs, 'retryMs');
  validateDuration(staleLockMs, 'staleLockMs');

  while (true) {
    const owner: MetadataLockOwner = {
      pid: process.pid,
      id: randomUUID(),
      acquiredAt: now(),
    };
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, 'wx', FILE_MODE);
      await ownerWriter(handle, owner);
    } catch (error) {
      if (handle) {
        await unlinkOwnedLockAfterFailure(lockPath);
        await closeHandle(handle);
        throw error;
      }
      if (!isNodeError(error, 'EEXIST')) throw error;
      const state = await inspectLock(lockPath, now(), staleLockMs, isAlive);
      if (state === 'stale') {
        await removeStaleLock(lockPath, now, staleLockMs, isAlive);
        continue;
      }
      if (state === 'gone') continue;
      if (now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Vercel metadata lock: ${lockPath}`);
      }
      await sleep(retryMs);
    }

    if (!handle) continue;
    let pathRemoved = false;
    let handleClosed = false;
    let released = false;
    return {
      path: lockPath,
      release: async () => {
        if (released) return;
        let failure: unknown;
        if (!pathRemoved) {
          try {
            await unlink(lockPath);
            pathRemoved = true;
          } catch (error) {
            if (isNodeError(error, 'ENOENT')) pathRemoved = true;
            else failure = error;
          }
        }
        if (!handleClosed) {
          try {
            await handle!.close();
            handleClosed = true;
          } catch (error) {
            failure ??= error;
          }
        }
        if (pathRemoved && handleClosed) released = true;
        if (failure) throw failure;
      },
    };
  }
}

async function writeLockOwner(handle: FileHandle, owner: MetadataLockOwner): Promise<void> {
  await handle.writeFile(JSON.stringify(owner) + '\n', 'utf8');
  await handle.sync();
}

async function unlinkOwnedLockAfterFailure(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) return;
  }
}

async function closeHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The original owner-write failure is the actionable error.
  }
}

type LockInspection = 'live' | 'stale' | 'gone';

async function inspectLock(
  lockPath: string,
  now: number,
  staleLockMs: number,
  isAlive: (pid: number) => boolean,
): Promise<LockInspection> {
  let stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'gone';
    throw error;
  }
  if (!stats.isFile()) throw new Error(`Metadata lock path is not a regular file: ${lockPath}`);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`Insecure metadata lock mode for ${lockPath}; expected owner-only access`);
  }

  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'gone';
    throw error;
  }
  const owner = parseLockOwner(raw);
  if (owner && isAlive(owner.pid)) return 'live';
  if (owner && !isAlive(owner.pid)) return 'stale';
  return now - stats.mtimeMs >= staleLockMs ? 'stale' : 'live';
}

async function removeStaleLock(
  lockPath: string,
  now: () => number,
  staleLockMs: number,
  isAlive: (pid: number) => boolean,
): Promise<void> {
  const quarantinePath = `${lockPath}.${randomUUID()}.stale`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, 'r');
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) return;
    const raw = await handle.readFile('utf8');
    const state = classifyLockContents(raw, stats.mtimeMs, now(), staleLockMs, isAlive);
    if (state !== 'stale') return;
    await rename(lockPath, quarantinePath);
    await unlink(quarantinePath);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  } finally {
    if (handle) await closeHandle(handle);
  }
}

function parseLockOwner(raw: string): MetadataLockOwner | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    if (
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      typeof value.acquiredAt !== 'number' ||
      !Number.isFinite(value.acquiredAt)
    ) return null;
    return { pid: value.pid, id: value.id, acquiredAt: value.acquiredAt };
  } catch {
    return null;
  }
}

function classifyLockContents(
  raw: string,
  mtimeMs: number,
  now: number,
  staleLockMs: number,
  isAlive: (pid: number) => boolean,
): LockInspection {
  const owner = parseLockOwner(raw);
  if (owner && isAlive(owner.pid)) return 'live';
  if (owner && !isAlive(owner.pid)) return 'stale';
  return now - mtimeMs >= staleLockMs ? 'stale' : 'live';
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function validateDuration(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Metadata lock ${field} must be non-negative`);
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

function parseMetadata(
  value: unknown,
  expectedProvider: string,
  expectedRepoKeyHash: string,
): VercelMetadata {
  if (!isRecord(value)) throw new Error('Malformed Vercel metadata: expected an object');
  const allowedFields = new Set([
    'schemaVersion',
    'provider',
    'repoKeyHash',
    'teamId',
    'projectId',
    'identity',
    'sandboxId',
    'snapshotIds',
    'residual',
  ]);
  const unknownFields = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknownFields.length > 0) {
    throw new Error(`Unknown Vercel metadata field(s): ${unknownFields.join(', ')}`);
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.provider !== 'string' ||
    typeof value.repoKeyHash !== 'string' ||
    typeof value.teamId !== 'string' ||
    typeof value.projectId !== 'string'
  ) {
    throw new Error('Malformed Vercel metadata: missing required non-secret fields');
  }
  if (value.provider !== expectedProvider) {
    throw new Error(`Vercel metadata provider mismatch: expected ${expectedProvider}`);
  }
  if (value.repoKeyHash !== expectedRepoKeyHash) {
    throw new Error('Vercel metadata repo key mismatch');
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
