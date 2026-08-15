import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseStoredMetadata,
  serializeMetadata,
  type VercelMetadata,
  type VercelMetadataInput,
} from './metadata-schema.js';
import {
  acquireMetadataLock,
  type MetadataLock,
  type MetadataLockOptions,
} from './metadata-lock.js';

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const APP_DIRECTORY = 'devbox';
const PROVIDERS_DIRECTORY = 'providers';
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface VercelMetadataStoreOptions {
  repoKey: string;
  provider?: string;
  stateHome?: string;
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
  if (!options.repoKey || options.repoKey.trim().length === 0) {
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
    read: async () => readMetadata(stateHome, directory, pathname, provider, repoKeyHash),
    write: async (metadata) => {
      await writeMetadata(stateHome, pathname, directory, metadata, provider, repoKeyHash);
    },
    remove: async () => {
      await ensurePrivateDirectories(stateHome, directory);
      await assertSecureFileIfPresent(pathname, 'metadata');
      try {
        await unlink(pathname);
        await fsyncDirectory(directory);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }
    },
    acquireLock: async (lockOptions) => {
      await ensurePrivateDirectories(stateHome, directory);
      return acquireMetadataLock(pathname, lockPath, lockOptions);
    },
    withLock: async <T>(operation: () => Promise<T>, lockOptions?: MetadataLockOptions) => {
      const lock = await acquireMetadataLockAfterDirectorySetup(
        stateHome,
        directory,
        pathname,
        lockPath,
        lockOptions,
      );
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    },
  };
}

async function acquireMetadataLockAfterDirectorySetup(
  stateHome: string,
  directory: string,
  pathname: string,
  lockPath: string,
  lockOptions?: MetadataLockOptions,
): Promise<MetadataLock> {
  await ensurePrivateDirectories(stateHome, directory);
  return acquireMetadataLock(pathname, lockPath, lockOptions);
}

async function readMetadata(
  stateHome: string,
  directory: string,
  pathname: string,
  expectedProvider: string,
  expectedRepoKeyHash: string,
): Promise<VercelMetadata | null> {
  await ensurePrivateDirectories(stateHome, directory);
  let handle: FileHandle | undefined;
  try {
    handle = await openSecureFile(pathname, 'r');
    const content = await handle.readFile('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`Malformed Vercel metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseStoredMetadata(parsed, expectedProvider, expectedRepoKeyHash);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  } finally {
    if (handle) await closeHandle(handle);
  }
}

async function writeMetadata(
  stateHome: string,
  pathname: string,
  directory: string,
  metadata: VercelMetadataInput,
  provider: string,
  repoKeyHash: string,
): Promise<void> {
  const content = serializeMetadata(metadata, provider, repoKeyHash);
  await ensurePrivateDirectories(stateHome, directory);
  await assertSecureFileIfPresent(pathname, 'metadata');

  const temporaryPath = `${pathname}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let renamed = false;
  let failure: unknown;
  try {
    handle = await open(temporaryPath, 'wx', FILE_MODE);
    await handle.writeFile(content, 'utf8');
    await handle.chmod(FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, pathname);
    renamed = true;
    await assertExactFileMode(pathname, 'metadata');
    await fsyncDirectory(directory);
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
  if (!renamed) {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) failure ??= error;
    }
  }
  if (failure) throw failure;
}

async function ensurePrivateDirectories(stateHome: string, directory: string): Promise<void> {
  await mkdir(stateHome, { recursive: true, mode: DIRECTORY_MODE });
  const appDirectory = join(stateHome, APP_DIRECTORY);
  const providersDirectory = join(appDirectory, PROVIDERS_DIRECTORY);
  await ensurePrivateDirectory(appDirectory);
  await ensurePrivateDirectory(providersDirectory);
  await ensurePrivateDirectory(directory);
}

async function ensurePrivateDirectory(pathname: string): Promise<void> {
  try {
    await mkdir(pathname, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  const stats = await lstat(pathname);
  if (!stats.isDirectory()) throw new Error(`Metadata path is not a directory: ${pathname}`);
  if ((stats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`Insecure metadata directory mode for ${pathname}; expected 0700`);
  }
}

async function assertSecureFileIfPresent(pathname: string, label: string): Promise<void> {
  try {
    await assertExactFileMode(pathname, label);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
}

async function assertExactFileMode(pathname: string, label: string): Promise<void> {
  const stats = await lstat(pathname);
  if (!stats.isFile()) throw new Error(`${label} path is not a regular file: ${pathname}`);
  if ((stats.mode & 0o777) !== FILE_MODE) {
    throw new Error(`Insecure ${label} mode for ${pathname}; expected 0600`);
  }
  const handle = await openSecureFile(pathname, 'r');
  await closeHandle(handle);
}

async function openSecureFile(pathname: string, flags: string): Promise<FileHandle> {
  const handle = await open(pathname, flags === 'r' ? constants.O_RDONLY | NO_FOLLOW : flags, FILE_MODE);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Metadata path is not a regular file: ${pathname}`);
    }
    if ((stats.mode & 0o777) !== FILE_MODE) {
      throw new Error(`Insecure metadata mode for ${pathname}; expected 0600`);
    }
    return handle;
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the validation or fstat error.
    }
    throw error;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await closeHandle(handle);
  }
}

async function closeHandle(handle: FileHandle): Promise<void> {
  await handle.close();
}

function validatePathComponent(value: string, field: string): void {
  if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error(`Metadata ${field} contains unsupported characters`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
