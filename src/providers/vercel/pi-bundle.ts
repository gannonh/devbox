import { constants } from 'node:fs';
import { open, realpath, readdir, stat, type FileHandle } from 'node:fs/promises';
import { join, relative as relativeFs, sep } from 'node:path';

const EXCLUDED_PREFIXES = ['agent/sessions', 'agent/npm', 'agent/cache'];
const MAX_SKIPPED_REPORT = 100;

type SkipReporter = (path: string, reason: string) => void;

export const DEFAULT_PI_BUNDLE_LIMITS = {
  maxEntries: 5_000,
  maxTotalBytes: 16 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
} as const;

export interface PiBundleEntry {
  path: string;
  content: Buffer;
  mode: number;
}

export interface PiBundle {
  entries: PiBundleEntry[];
  totalBytes: number;
  entryCount: number;
  skipped: { path: string; reason: string }[];
  skippedCount: number;
  rootMissing?: boolean;
  rootInvalid?: boolean;
}

export interface PiBundleLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export interface PiBundleOptions {
  root?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  limits?: Partial<PiBundleLimits>;
}

export class PiBundleLimitError extends Error {
  readonly code = 'pi_bundle_limit_exceeded';

  constructor(message: string) {
    super(message);
    this.name = 'PiBundleLimitError';
  }
}

export class PiBundleReadError extends Error {
  readonly code = 'pi_bundle_short_read';

  constructor(message: string) {
    super(message);
    this.name = 'PiBundleReadError';
  }
}

interface BundleState {
  entries: PiBundleEntry[];
  totalBytes: number;
  entryCount: number;
  limits: PiBundleLimits;
}

export async function collectPiBundle(options: PiBundleOptions = {}): Promise<PiBundle> {
  const state: BundleState = {
    entries: [],
    totalBytes: 0,
    entryCount: 0,
    limits: {
      maxEntries: options.limits?.maxEntries ?? DEFAULT_PI_BUNDLE_LIMITS.maxEntries,
      maxTotalBytes: options.limits?.maxTotalBytes ?? DEFAULT_PI_BUNDLE_LIMITS.maxTotalBytes,
      maxFileBytes: options.limits?.maxFileBytes ?? DEFAULT_PI_BUNDLE_LIMITS.maxFileBytes,
    },
  };
  const root = resolvePiRoot(options);
  const skipped: { path: string; reason: string }[] = [];
  let skippedCount = 0;
  const reportSkipped: SkipReporter = (path, reason) => {
    skippedCount += 1;
    if (skipped.length < MAX_SKIPPED_REPORT) skipped.push({ path, reason });
  };
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return { entries: state.entries, totalBytes: 0, entryCount: 0, skipped, skippedCount, rootMissing: true };
    }
    if (isRecoverablePathError(error)) {
      reportSkipped(root, `Pi root could not be resolved (${nodeErrorCode(error)})`);
      return { entries: state.entries, totalBytes: 0, entryCount: 0, skipped, skippedCount, rootInvalid: true };
    }
    throw error;
  }
  let rootMetadata;
  try {
    rootMetadata = await stat(resolvedRoot);
  } catch (error) {
    if (isRecoverablePathError(error)) {
      reportSkipped(root, `Pi root could not be inspected (${nodeErrorCode(error)})`);
      return { entries: state.entries, totalBytes: 0, entryCount: 0, skipped, skippedCount, rootInvalid: true };
    }
    throw error;
  }
  if (!rootMetadata.isDirectory()) {
    reportSkipped(root, 'Pi root is not a directory (ENOTDIR)');
    return { entries: state.entries, totalBytes: 0, entryCount: 0, skipped, skippedCount, rootInvalid: true };
  }
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  const visitedDirectories = new Set([resolvedRoot]);

  async function descend(
    directory: string,
    relativeDirectory: string,
    resolvedDirectory: string,
  ): Promise<void> {
    if (visitedDirectories.has(resolvedDirectory)) {
      reportSkipped(relativeDirectory, 'directory cycle detected');
      return;
    }
    visitedDirectories.add(resolvedDirectory);
    await walk(directory, relativeDirectory);
  }

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    let items;
    try {
      items = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isRecoverablePathError(error)) {
        reportSkipped(
          relativeDirectory || '.',
          `directory could not be read (${nodeErrorCode(error)})`,
        );
        return;
      }
      throw error;
    }
    for (const item of items) {
      const sourcePath = join(directory, item.name);
      const relativePath = toPosixPath(join(relativeDirectory, item.name));
      if (isExcluded(relativePath)) continue;
      if (!item.isDirectory() && !item.isFile() && !item.isSymbolicLink()) {
        reportSkipped(relativePath, nonRegularReason(item));
        continue;
      }
      const resolvedPath = await resolveEntry(sourcePath, relativePath, reportSkipped);
      if (resolvedPath === undefined) continue;
      const canonicalRelativePath = toPosixPath(relativeFs(resolvedRoot, resolvedPath));
      if (isExcluded(canonicalRelativePath)) {
        reportSkipped(relativePath, `canonical path is excluded: ${canonicalRelativePath}`);
        continue;
      }
      if (!isWithinRoot(resolvedPath, resolvedRoot, rootPrefix)) {
        reportSkipped(
          relativePath,
          item.isSymbolicLink() ? 'symlink resolves outside Pi root' : 'path resolves outside Pi root',
        );
        continue;
      }
      if (item.isDirectory()) {
        await descend(sourcePath, relativePath, resolvedPath);
      } else if (item.isFile()) {
        await addFile(state, relativePath, sourcePath, false, resolvedRoot, rootPrefix, reportSkipped);
      } else {
        let metadata;
        try {
          metadata = await stat(sourcePath);
        } catch (error) {
          if (isRecoverablePathError(error)) {
            reportSkipped(relativePath, `path could not be inspected (${nodeErrorCode(error)})`);
            continue;
          }
          throw error;
        }
        if (metadata.isDirectory()) await descend(sourcePath, relativePath, resolvedPath);
        else if (metadata.isFile()) {
          await addFile(state, relativePath, resolvedPath, true, resolvedRoot, rootPrefix, reportSkipped);
        } else {
          reportSkipped(relativePath, nonRegularReason(metadata));
        }
      }
    }
  }

  await walk(resolvedRoot, '');
  return {
    entries: state.entries,
    totalBytes: state.totalBytes,
    entryCount: state.entryCount,
    skipped,
    skippedCount,
  };
}

async function addFile(
  state: BundleState,
  relativePath: string,
  readPath: string,
  symbolicLink: boolean,
  resolvedRoot: string,
  rootPrefix: string,
  reportSkipped: SkipReporter,
): Promise<void> {
  const nextEntryCount = state.entryCount + 1;
  if (nextEntryCount > state.limits.maxEntries) {
    throw new PiBundleLimitError(
      `Pi bundle exceeds the maximum of ${state.limits.maxEntries} entries: `
      + `observed ${nextEntryCount}; offending path: ${relativePath}`,
    );
  }

  let file: FileHandle;
  try {
    file = await open(readPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = nodeErrorCode(error);
    if (isSkippablePathError(error)) {
      reportSkipped(relativePath, `file could not be opened (${code})`);
      return;
    }
    throw error;
  }

  try {
    let actualPath: string;
    try {
      actualPath = await realpath(readPath);
    } catch (error) {
      if (isSkippablePathError(error)) {
        reportSkipped(relativePath, `path could not be resolved (${nodeErrorCode(error)})`);
        return;
      }
      throw error;
    }
    const canonicalRelativePath = toPosixPath(relativeFs(resolvedRoot, actualPath));
    if (isExcluded(canonicalRelativePath)) {
      reportSkipped(relativePath, `canonical path is excluded: ${canonicalRelativePath}`);
      return;
    }
    // Hard-link policy: accept an inode reached by an in-root path; tracing its
    // origin or link farms adds complexity without strengthening this boundary.
    // O_NOFOLLOW + post-open realpath + dev/ino comparison narrows the TOCTOU
    // window; it does not make validation atomic.
    if (!isWithinRoot(actualPath, resolvedRoot, rootPrefix)) {
      reportSkipped(
        relativePath,
        symbolicLink ? 'symlink resolves outside Pi root' : 'path resolves outside Pi root',
      );
      return;
    }
    let metadata;
    let pathMetadata;
    try {
      metadata = await file.stat();
      pathMetadata = await stat(actualPath);
    } catch (error) {
      if (isSkippablePathError(error)) {
        reportSkipped(relativePath, `path could not be inspected (${nodeErrorCode(error)})`);
        return;
      }
      throw error;
    }
    if (metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino) {
      reportSkipped(relativePath, 'file changed during collection');
      return;
    }
    if (!metadata.isFile()) return;
    const fileSize = metadata.size;
    if (fileSize > state.limits.maxFileBytes) {
      throw new PiBundleLimitError(
        `Pi bundle file exceeds the maximum of ${state.limits.maxFileBytes} bytes: `
        + `observed ${fileSize} bytes; offending path: ${relativePath}`,
      );
    }
    const nextTotalBytes = state.totalBytes + fileSize;
    if (nextTotalBytes > state.limits.maxTotalBytes) {
      throw new PiBundleLimitError(
        `Pi bundle exceeds the maximum of ${state.limits.maxTotalBytes} regular-file bytes: `
        + `observed ${nextTotalBytes} bytes; offending path: ${relativePath} (${fileSize} bytes)`,
      );
    }
    let content: Buffer;
    try {
      content = await readFileFromHandle(file, fileSize, relativePath);
    } catch (error) {
      if (isSkippablePathError(error)) {
        reportSkipped(relativePath, `file could not be read (${nodeErrorCode(error)})`);
        return;
      }
      throw error;
    }
    state.entries.push({ path: relativePath, content, mode: metadata.mode & 0o7777 });
    state.entryCount = nextEntryCount;
    state.totalBytes += content.byteLength;
  } finally {
    await file.close();
  }
}

async function readFileFromHandle(file: FileHandle, size: number, relativePath: string): Promise<Buffer> {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(content, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) {
    throw new PiBundleReadError(
      `Pi bundle short read for ${relativePath}: expected ${size} bytes, received ${offset} bytes`,
    );
  }
  return content;
}

async function resolveEntry(
  sourcePath: string,
  relativePath: string,
  reportSkipped: SkipReporter,
): Promise<string | undefined> {
  try {
    return await realpath(sourcePath);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (isSkippablePathError(error)) {
      reportSkipped(relativePath, `path could not be resolved (${code})`);
      return undefined;
    }
    throw error;
  }
}

function nonRegularReason(entry: {
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}): string {
  if (entry.isFIFO()) return 'FIFO is not a regular file or directory';
  if (entry.isSocket()) return 'socket is not a regular file or directory';
  if (entry.isBlockDevice()) return 'block device is not a regular file or directory';
  if (entry.isCharacterDevice()) return 'character device is not a regular file or directory';
  return 'entry is not a regular file or directory';
}

function isRecoverablePathError(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR';
}

function isSkippablePathError(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return isRecoverablePathError(error) || code === 'ENOENT' || code === 'ELOOP';
}

function isWithinRoot(path: string, root: string, rootPrefix: string): boolean {
  return path === root || path.startsWith(rootPrefix);
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function resolvePiRoot(options: PiBundleOptions): string {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? process.env.HOME ?? '';
  return options.root ?? join(home, '.pi');
}

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.replaceAll(sep, '/');
}
