import lockfile from 'proper-lockfile';

export interface MetadataLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface MetadataLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleLockMs?: number;
  onCompromised?: (error: Error) => void;
}

export async function acquireMetadataLock(
  targetPath: string,
  lockPath: string,
  options: MetadataLockOptions = {},
): Promise<MetadataLock> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 25;
  const staleLockMs = Math.max(options.staleLockMs ?? 10_000, 2_000);
  validateDuration(timeoutMs, 'timeoutMs');
  validateDuration(retryMs, 'retryMs');
  validateDuration(staleLockMs, 'staleLockMs');

  const retryDelay = Math.max(1, retryMs);
  const retries = Math.max(0, Math.ceil(timeoutMs / retryDelay));
  let release: (() => Promise<void>) | undefined;
  const lockOptions = {
    lockfilePath: lockPath,
    realpath: false,
    stale: staleLockMs,
    update: Math.max(1_000, Math.floor(staleLockMs / 2)),
    retries: {
      retries,
      factor: 1,
      minTimeout: retryDelay,
      maxTimeout: retryDelay,
      randomize: false,
      maxRetryTime: timeoutMs,
      unref: false,
    },
    ...(options.onCompromised === undefined ? {} : { onCompromised: options.onCompromised }),
  };
  try {
    release = await lockfile.lock(targetPath, lockOptions);
  } catch (error) {
    if (isAlreadyHeldError(error)) {
      throw new Error(`Timed out waiting for Vercel metadata lock: ${lockPath}`, { cause: error });
    }
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) return;
      await release!();
      released = true;
    },
  };
}

function isAlreadyHeldError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOCKED';
}

function validateDuration(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Metadata lock ${field} must be non-negative`);
  }
}
