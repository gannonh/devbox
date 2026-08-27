import type { Writable } from 'node:stream';
import type { VercelSandboxClient, VercelSandboxHandle } from './client.js';
import { readSetupStatus, type VercelSetupStatus } from './setup.js';

export const DEFAULT_IDLE_PAUSE_MINUTES = 15;
export const MAX_IDLE_PAUSE_MINUTES = 24 * 60;
export const VERCEL_RUNTIME_HEARTBEAT_PATH = '/vercel/.devbox/runtime/heartbeat';
export const IDLE_POLL_INTERVAL_MS = 60_000;

export interface IdlePauseScheduler {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdlePauseObservation {
  nowMs: number;
  readyAtMs: number;
  idlePauseMinutes: number;
  heartbeatMs?: number;
  setupStatus?: VercelSetupStatus | null;
}

export function resolveIdlePauseMinutes(
  explicit: string | undefined,
  stored: number | undefined,
): number {
  if (explicit !== undefined) return parseIdlePauseMinutes(explicit);
  if (stored !== undefined) return stored;
  return DEFAULT_IDLE_PAUSE_MINUTES;
}

export function parseIdlePauseMinutes(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('DEVBOX_IDLE_PAUSE_MINUTES must be an integer between 0 and 1440');
  }
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > MAX_IDLE_PAUSE_MINUTES) {
    throw new Error('DEVBOX_IDLE_PAUSE_MINUTES must be an integer between 0 and 1440');
  }
  return minutes;
}

export function decideIdlePause(observation: IdlePauseObservation): boolean {
  if (observation.idlePauseMinutes === 0) return false;
  const windowMs = observation.idlePauseMinutes * 60_000;
  if (observation.nowMs - observation.readyAtMs < windowMs) return false;
  if (observation.setupStatus?.status === 'running') return false;
  if (observation.heartbeatMs !== undefined
    && observation.nowMs - observation.heartbeatMs < windowMs) return false;
  return true;
}

export interface RemoteHeartbeatOptions {
  sandbox: VercelSandboxHandle;
  client: VercelSandboxClient;
  signal?: AbortSignal;
}

export async function touchRemoteHeartbeat(options: RemoteHeartbeatOptions): Promise<void> {
  const result = await options.client.runCommand(options.sandbox, {
    cmd: 'sh',
    args: [
      '-c',
      `umask 077; mkdir -p /vercel/.devbox/runtime; date +%s > ${VERCEL_RUNTIME_HEARTBEAT_PATH}; chmod 600 ${VERCEL_RUNTIME_HEARTBEAT_PATH}`,
    ],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.exitCode !== 0) throw new Error('remote heartbeat write failed');
}

export async function readRemoteHeartbeat(
  options: RemoteHeartbeatOptions,
): Promise<number | undefined> {
  try {
    const result = await options.client.runCommand(options.sandbox, {
      cmd: 'stat',
      args: ['-c', '%Y', VERCEL_RUNTIME_HEARTBEAT_PATH],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.exitCode !== 0 || !result.stdout) return undefined;
    const seconds = Number((await result.stdout(
      options.signal === undefined ? undefined : { signal: options.signal },
    )).trim());
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return seconds * 1_000;
  } catch {
    return undefined;
  }
}

export interface HeartbeatWriter {
  readonly onInputActivity: () => void;
  touch(): Promise<void>;
  stop(): void;
}

export async function createHeartbeatWriter(
  options: RemoteHeartbeatOptions & { initialTouch?: boolean },
): Promise<HeartbeatWriter> {
  let stopped = false;
  let writing = false;
  let pending = false;
  const drain = async (): Promise<void> => {
    if (writing || stopped) return;
    writing = true;
    try {
      while (pending && !stopped) {
        pending = false;
        try {
          await touchRemoteHeartbeat(options);
        } catch {
          // An activity signal must never break the terminal transport.
        }
      }
    } finally {
      writing = false;
    }
  };
  const touch = async (): Promise<void> => {
    pending = true;
    await drain();
  };
  if (options.initialTouch === true) await touch();
  return {
    onInputActivity: () => {
      pending = true;
      void drain();
    },
    touch,
    stop: () => {
      stopped = true;
      pending = false;
    },
  };
}

export interface IdlePauseMonitorOptions extends RemoteHeartbeatOptions {
  idlePauseMinutes: number;
  pause: () => Promise<unknown>;
  stderr: Writable;
  readyAtMs?: number;
  now?: () => number;
  scheduler?: IdlePauseScheduler;
  readHeartbeat?: () => Promise<number | undefined>;
  readSetup?: () => Promise<VercelSetupStatus | null>;
  pollIntervalMs?: number;
}

export interface IdlePauseMonitorHandle {
  stop(): void;
  /** Settles when the monitor stops after a successful pause or an explicit stop. */
  readonly done: Promise<void>;
}

export function startIdlePauseMonitor(options: IdlePauseMonitorOptions): IdlePauseMonitorHandle {
  if (options.idlePauseMinutes === 0) {
    return { stop() {}, done: Promise.resolve() };
  }
  const scheduler = options.scheduler ?? {
    setTimeout: (callback: () => void, delay: number) => {
      const handle = setTimeout(callback, delay);
      // Detached terminals leave this monitor running after attach returns. Keep
      // the handle unref'd so a test process can exit if it does not await done.
      handle.unref?.();
      return handle;
    },
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } satisfies IdlePauseScheduler;
  const now = options.now ?? (() => Date.now());
  const readyAtMs = options.readyAtMs ?? now();
  const pollIntervalMs = Math.max(
    1_000,
    Math.min(options.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS, options.idlePauseMinutes * 60_000),
  );
  const readHeartbeat = options.readHeartbeat ?? (() => readRemoteHeartbeat(options));
  const readSetup = options.readSetup ?? (() => readSetupStatus({
    sandbox: options.sandbox,
    client: options.client,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }));
  let stopped = false;
  let checking = false;
  let timer: unknown;
  let settleDone!: () => void;
  const done = new Promise<void>((resolve) => {
    settleDone = resolve;
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = undefined;
    settleDone();
  };
  const schedule = () => {
    if (stopped || options.signal?.aborted) return;
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      void check();
    }, pollIntervalMs);
  };
  const check = async (): Promise<void> => {
    if (stopped || checking || options.signal?.aborted) return;
    checking = true;
    try {
      const [heartbeatMs, setupStatus] = await Promise.all([
        readHeartbeat(),
        readSetup().catch(() => null),
      ]);
      if (decideIdlePause({
        nowMs: now(),
        readyAtMs,
        idlePauseMinutes: options.idlePauseMinutes,
        ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
        setupStatus,
      })) {
        try {
          await options.pause();
          options.stderr.write('Vercel sandbox auto-paused after the idle window\n');
        } catch {
          options.stderr.write('Vercel sandbox idle pause failed; continuing to monitor\n');
          schedule();
        }
        if (!stopped && timer === undefined) stop();
      } else {
        schedule();
      }
    } finally {
      checking = false;
    }
  };
  schedule();
  options.signal?.addEventListener('abort', stop, { once: true });
  return {
    stop: () => {
      stop();
      options.signal?.removeEventListener('abort', stop);
    },
    done,
  };
}
