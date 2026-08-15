import type { VercelCredentials } from './auth.js';
import {
  collectPaginated,
  isVercelNotFound,
  type SandboxSessionRecord,
  type SandboxSnapshotRecord,
  type SandboxSessionStatus,
  type VercelStopResult,
} from './client.js';
import { redactSecrets } from './redaction.js';

export const TERMINAL_SESSION_STATES = new Set<SandboxSessionStatus>(['stopped', 'aborted']);
const STOPPABLE_SESSION_STATES = new Set<SandboxSessionStatus>([
  'pending',
  'running',
  'stopping',
  'snapshotting',
]);

export interface VercelCleanupSandbox {
  readonly id?: string;
  readonly name: string;
  readonly status: SandboxSessionStatus;
  readonly tags?: Record<string, string>;
}

export interface VercelCleanupSnapshot {
  readonly snapshotId: string;
  readonly status: 'failed' | 'created' | 'deleted';
  delete(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface VercelCleanupAdapter {
  get(request: {
    credentials: VercelCredentials;
    name: string;
    resume: false;
    signal?: AbortSignal;
  }): Promise<VercelCleanupSandbox>;
  listSessions(
    sandbox: VercelCleanupSandbox,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  stop(
    sandbox: VercelCleanupSandbox,
    options?: { signal?: AbortSignal },
  ): Promise<VercelStopResult>;
  listSnapshots(request: {
    credentials: VercelCredentials;
    name: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  getSnapshot(request: {
    credentials: VercelCredentials;
    snapshotId: string;
    signal?: AbortSignal;
  }): Promise<VercelCleanupSnapshot>;
  delete(sandbox: VercelCleanupSandbox, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface VercelCleanupResult {
  verified: boolean;
  sandboxDeleted: boolean;
  snapshotsCleaned: boolean;
  sandboxMissing: boolean;
  snapshotIds: string[];
  residualSandboxIds: string[];
  residualSnapshotIds: string[];
  finalSessions: SandboxSessionRecord[];
  finalStop?: VercelStopResult;
  errors: string[];
}

export interface VercelCleanupOptions {
  name: string;
  credentials: VercelCredentials;
  adapter: VercelCleanupAdapter;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export async function cleanupVercelSandbox(
  options: VercelCleanupOptions,
): Promise<VercelCleanupResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const backoffMs = options.backoffMs ?? 50;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Vercel cleanup timeoutMs must be positive');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('Vercel cleanup maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new TypeError('Vercel cleanup backoffMs must be non-negative');
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const errors: string[] = [];
  const snapshotIds = new Set<string>();
  let residualSnapshotIds = new Set<string>();
  const residualSandboxIds = new Set<string>();
  let finalSessions: SandboxSessionRecord[] = [];
  let finalStop: VercelStopResult | undefined;
  let sandbox: VercelCleanupSandbox | undefined;
  let sandboxMissing = false;
  let sandboxDeleted = false;
  let snapshotsCleaned = false;
  let sessionObservationOk = true;
  let snapshotListingOk = true;

  const recordError = (operation: string, error: unknown): void => {
    const detail = redactSecrets(error, [options.credentials.token]).slice(0, 500);
    errors.push(`${operation}: ${detail}`);
  };
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('Vercel cleanup was aborted');
    }
  };
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const sleep = options.sleep ?? defaultSleep;

  try {
    throwIfAborted();
    sandbox = await options.adapter.get({
      credentials: options.credentials,
      name: options.name,
      resume: false,
      signal: options.signal,
    });
  } catch (error) {
    if (isVercelNotFound(error)) {
      sandboxMissing = true;
      sandboxDeleted = true;
    } else recordError('sandbox lookup', error);
  }

  if (sandbox) {
    let observation = await listSessions(options.adapter, sandbox, options.signal, recordError);
    sessionObservationOk = observation.ok;
    finalSessions = observation.sessions;
    const needsStop =
      STOPPABLE_SESSION_STATES.has(sandbox.status) ||
      observation.sessions.some((session) => STOPPABLE_SESSION_STATES.has(session.status));
    if (needsStop) {
      try {
        finalStop = await options.adapter.stop(sandbox, { signal: options.signal });
      } catch (error) {
        recordError('sandbox stop', error);
      }
      observation = await listSessions(options.adapter, sandbox, options.signal, recordError);
      sessionObservationOk = sessionObservationOk && observation.ok;
      finalSessions = observation.sessions;
    }
    if (!sessionObservationOk || hasNonTerminalSessions(finalSessions)) {
      for (const session of finalSessions) {
        if (!TERMINAL_SESSION_STATES.has(session.status)) {
          residualSandboxIds.add(sandboxIdentifier(sandbox) ?? options.name);
        }
      }
      if (sessionObservationOk) {
        recordError('session verification', new Error('not every Sandbox session is stopped or aborted'));
      }
    }
  }

  let snapshotObservation = await listSnapshots(
    options.adapter,
    options.credentials,
    options.name,
    options.signal,
    recordError,
  );
  snapshotListingOk = snapshotObservation.ok;
  let listedSnapshots = snapshotObservation.snapshots;
  rememberSnapshots(listedSnapshots, snapshotIds, residualSnapshotIds);

  if (snapshotListingOk) {
    await deleteNonDeletedSnapshots(
      listedSnapshots,
      options,
      snapshotIds,
      residualSnapshotIds,
      recordError,
    );
  }

  if (sandbox && sessionObservationOk && !hasNonTerminalSessions(finalSessions)) {
    try {
      await options.adapter.delete(sandbox, { signal: options.signal });
    } catch (error) {
      if (isVercelNotFound(error)) sandboxDeleted = true;
      else recordError('sandbox delete', error);
    }
  }

  let attempts = 0;
  while (attempts < maxAttempts && remaining() > 0) {
    throwIfAborted();
    attempts += 1;

    if (!sandboxMissing && !sandboxDeleted) {
      try {
        const observed = await options.adapter.get({
          credentials: options.credentials,
          name: options.name,
          resume: false,
          signal: options.signal,
        });
        sandbox = observed;
        let observation = await listSessions(options.adapter, observed, options.signal, recordError);
        sessionObservationOk = observation.ok;
        finalSessions = observation.sessions;
        if (sessionObservationOk && hasNonTerminalSessions(finalSessions)) {
          try {
            finalStop = await options.adapter.stop(observed, { signal: options.signal });
            observation = await listSessions(options.adapter, observed, options.signal, recordError);
            sessionObservationOk = observation.ok;
            finalSessions = observation.sessions;
          } catch (error) {
            recordError('sandbox retry stop', error);
          }
        }
        if (sessionObservationOk && !hasNonTerminalSessions(finalSessions)) {
          try {
            await options.adapter.delete(observed, { signal: options.signal });
          } catch (error) {
            if (isVercelNotFound(error)) sandboxDeleted = true;
            else recordError('sandbox retry delete', error);
          }
        }
      } catch (error) {
        if (isVercelNotFound(error)) {
          sandboxDeleted = true;
          sandboxMissing = true;
          sessionObservationOk = true;
        } else {
          recordError('sandbox deletion verification', error);
        }
      }
    }

    snapshotObservation = await listSnapshots(
      options.adapter,
      options.credentials,
      options.name,
      options.signal,
      recordError,
    );
    snapshotListingOk = snapshotObservation.ok;
    listedSnapshots = snapshotObservation.snapshots;
    if (snapshotListingOk) {
      rememberSnapshots(listedSnapshots, snapshotIds, residualSnapshotIds);
      residualSnapshotIds = new Set(
        listedSnapshots.filter((snapshot) => snapshot.status !== 'deleted').map((snapshot) => snapshot.id),
      );
      if (residualSnapshotIds.size === 0) snapshotsCleaned = true;
      else {
        snapshotsCleaned = false;
        await deleteNonDeletedSnapshots(
          listedSnapshots,
          options,
          snapshotIds,
          residualSnapshotIds,
          recordError,
        );
      }
    } else {
      snapshotsCleaned = false;
    }

    if (sandboxDeleted && snapshotsCleaned && sessionObservationOk && !hasNonTerminalSessions(finalSessions)) break;
    if (attempts < maxAttempts && remaining() > 0) {
      await sleep(Math.min(backoffMs * attempts, remaining()), options.signal);
    }
  }

  if (!sandboxDeleted && (sandboxMissing || attempts >= maxAttempts || remaining() <= 0)) {
    residualSandboxIds.add(sandboxIdentifier(sandbox) ?? options.name);
  }
  if (!snapshotsCleaned) {
    residualSnapshotIds = new Set(residualSnapshotIds);
  }

  const terminal = sessionObservationOk && !hasNonTerminalSessions(finalSessions);
  const verified = sandboxDeleted && snapshotsCleaned && terminal;
  return {
    verified,
    sandboxDeleted,
    snapshotsCleaned,
    sandboxMissing,
    snapshotIds: [...snapshotIds],
    residualSandboxIds: [...residualSandboxIds],
    residualSnapshotIds: [...residualSnapshotIds],
    finalSessions,
    ...(finalStop === undefined ? {} : { finalStop }),
    errors,
  };
}

interface SessionObservation {
  sessions: SandboxSessionRecord[];
  ok: boolean;
}

interface SnapshotObservation {
  snapshots: SandboxSnapshotRecord[];
  ok: boolean;
}

async function listSessions(
  adapter: VercelCleanupAdapter,
  sandbox: VercelCleanupSandbox,
  signal: AbortSignal | undefined,
  recordError: (operation: string, error: unknown) => void,
): Promise<SessionObservation> {
  try {
    return {
      sessions: await collectPaginated(await adapter.listSessions(sandbox, { signal }), 'sessions'),
      ok: true,
    };
  } catch (error) {
    recordError('session listing', error);
    return { sessions: [], ok: false };
  }
}

async function listSnapshots(
  adapter: VercelCleanupAdapter,
  credentials: VercelCredentials,
  name: string,
  signal: AbortSignal | undefined,
  recordError: (operation: string, error: unknown) => void,
): Promise<SnapshotObservation> {
  try {
    return {
      snapshots: await collectPaginated(
        await adapter.listSnapshots({ credentials, name, signal }),
        'snapshots',
      ),
      ok: true,
    };
  } catch (error) {
    recordError('snapshot listing', error);
    return { snapshots: [], ok: false };
  }
}

async function deleteNonDeletedSnapshots(
  snapshots: SandboxSnapshotRecord[],
  options: VercelCleanupOptions,
  snapshotIds: Set<string>,
  residualSnapshotIds: Set<string>,
  recordError: (operation: string, error: unknown) => void,
): Promise<void> {
  for (const listed of snapshots) {
    snapshotIds.add(listed.id);
    if (listed.status === 'deleted') {
      residualSnapshotIds.delete(listed.id);
      continue;
    }
    try {
      const snapshot = await options.adapter.getSnapshot({
        credentials: options.credentials,
        snapshotId: listed.id,
        signal: options.signal,
      });
      if (snapshot.status !== 'deleted') {
        await snapshot.delete({ signal: options.signal });
      }
      residualSnapshotIds.delete(listed.id);
    } catch (error) {
      if (isVercelNotFound(error)) residualSnapshotIds.delete(listed.id);
      else recordError(`snapshot delete ${listed.id}`, error);
    }
  }
}

function rememberSnapshots(
  snapshots: SandboxSnapshotRecord[],
  snapshotIds: Set<string>,
  residualSnapshotIds: Set<string>,
): void {
  for (const snapshot of snapshots) {
    snapshotIds.add(snapshot.id);
    if (snapshot.status === 'deleted') residualSnapshotIds.delete(snapshot.id);
    else residualSnapshotIds.add(snapshot.id);
  }
}

function hasNonTerminalSessions(sessions: SandboxSessionRecord[]): boolean {
  return sessions.some((session) => !TERMINAL_SESSION_STATES.has(session.status));
}

function sandboxIdentifier(sandbox: VercelCleanupSandbox | undefined): string | undefined {
  if (!sandbox) return undefined;
  return sandbox.id?.trim() || sandbox.name;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Vercel cleanup was aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
