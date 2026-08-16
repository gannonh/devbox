import type { VercelInteractiveSandbox } from './terminal.js';

const DEFAULT_TIMEOUT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_EXTENSION_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_BUFFER_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface VercelTerminalTimeoutScheduler {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VercelTerminalTimeoutOptions {
  intervalMs?: number;
  extensionMs?: number;
  bufferMs?: number;
  scheduler?: VercelTerminalTimeoutScheduler;
}

export function startTimeoutExtension(
  sandbox: VercelInteractiveSandbox,
  options: VercelTerminalTimeoutOptions,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): () => void {
  if (!sandbox.extendTimeout) return () => {};
  const extensionMs = options.extensionMs ?? DEFAULT_TIMEOUT_EXTENSION_MS;
  const bufferMs = options.bufferMs ?? DEFAULT_TIMEOUT_BUFFER_MS;
  if (!isPositiveFinite(options.intervalMs ?? DEFAULT_TIMEOUT_INTERVAL_MS)
    || !isPositiveFinite(extensionMs)
    || !isNonNegativeFinite(bufferMs)) {
    throw new Error('Terminal timeout extension values must be finite and positive');
  }
  const scheduler = options.scheduler ?? {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } satisfies VercelTerminalTimeoutScheduler;
  let stopped = false;
  let timer: unknown;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (stopped || signal.aborted) return;
    const delay = timeoutDelay(sandbox, options, bufferMs);
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      if (stopped || signal.aborted) return;
      void sandbox.extendTimeout!(extensionMs, { signal }).then(
        () => schedule(),
        (error) => {
          if (!stopped && !signal.aborted) {
            stopped = true;
            onError(error);
          }
        },
      );
    }, delay);
  };
  signal.addEventListener('abort', stop, { once: true });
  schedule();
  return () => {
    stop();
    signal.removeEventListener('abort', stop);
  };
}

function timeoutDelay(
  sandbox: VercelInteractiveSandbox,
  options: VercelTerminalTimeoutOptions,
  bufferMs: number,
): number {
  if (options.intervalMs !== undefined) return Math.min(options.intervalMs, MAX_TIMER_DELAY_MS);
  const expiresAt = sandbox.expiresAt?.getTime()
    ?? (sandbox.createdAt && sandbox.timeout !== undefined
      ? sandbox.createdAt.getTime() + sandbox.timeout
      : undefined);
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
    return DEFAULT_TIMEOUT_INTERVAL_MS;
  }
  return Math.min(Math.max(0, expiresAt - Date.now() - bufferMs), MAX_TIMER_DELAY_MS);
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
