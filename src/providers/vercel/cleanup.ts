import type { VercelCredentials } from './auth.js';
import type { VercelIdentityTags } from './metadata-schema.js';
import {
  collectPaginated,
  isVercelNotFound,
  isVercelStale,
  type SandboxSessionRecord,
  type SandboxSnapshotRecord,
  type SandboxSessionStatus,
  type VercelSandboxDeleteByNameResult,
  type VercelStopResult,
} from './client.js';
import { redactSecrets } from './redaction.js';

export const TERMINAL_SESSION_STATES = new Set<SandboxSessionStatus>(['stopped', 'aborted']);
export const STOPPABLE_SESSION_STATES = new Set<SandboxSessionStatus>([
  'pending',
  'running',
  'stopping',
  'snapshotting',
]);

export interface VercelCleanupSandbox {
  readonly id?: string;
  readonly name: string;
  readonly status: SandboxSessionStatus;
  readonly persistent?: boolean;
  readonly tags?: Record<string, string>;
  readonly currentSnapshotId?: string;
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
  deleteByName(request: {
    credentials: VercelCredentials;
    name: string;
    signal?: AbortSignal;
  }): Promise<VercelSandboxDeleteByNameResult>;
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
  expectedTags: VercelIdentityTags;
  knownSnapshotIds?: readonly string[];
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

  const deadline = Date.now() + timeoutMs;
  const errors: string[] = [];
  const snapshotIds = new Set<string>();
  const knownSnapshotIds = new Set<string>();
  const residualSnapshotIds = new Set<string>();
  const snapshotStatuses = new Map<string, SandboxSnapshotRecord['status']>();
  const residualSandboxIds = new Set<string>();
  for (const snapshotId of options.knownSnapshotIds ?? []) {
    rememberSnapshotId(snapshotId, knownSnapshotIds, snapshotIds, residualSnapshotIds);
  }

  let finalSessions: SandboxSessionRecord[] = [];
  let finalStop: VercelStopResult | undefined;
  let sandbox: VercelCleanupSandbox | undefined;
  let sandboxMissing = false;
  let sandboxDeleted = false;
  let snapshotsCleaned = false;
  let sandboxLookupOk = true;
  let sandboxIdentityVerified = true;
  let staleSandbox = false;
  let sessionObservationOk = false;
  let absentRelistStreak = 0;

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
      sessionObservationOk = true;
    } else if (isVercelStale(error)) {
      staleSandbox = true;
      sessionObservationOk = true;
    } else {
      sandboxLookupOk = false;
      residualSandboxIds.add(options.name);
      recordError('sandbox lookup', error);
    }
  }

  if (sandbox && !matchesExpectedIdentity(sandbox, options.name, options.expectedTags)) {
    sandboxIdentityVerified = false;
    residualSandboxIds.add(sandboxIdentifier(sandbox) ?? options.name);
    recordError(
      'sandbox identity verification',
      new Error(`fetched sandbox does not match expected name or identity tags for ${options.name}`),
    );
    sandbox = undefined;
  }
  if (sandbox) {
    rememberSnapshotId(sandbox.currentSnapshotId, knownSnapshotIds, snapshotIds, residualSnapshotIds);
  }

  const processSnapshotRelist = async (attemptedSnapshotIds: Set<string>, allowDelete = true): Promise<boolean> => {
    const snapshotObservation = await listSnapshots(
      options.adapter,
      options.credentials,
      options.name,
      options.signal,
      recordError,
    );
    if (!snapshotObservation.ok) {
      snapshotsCleaned = false;
      absentRelistStreak = 0;
      return false;
    }
    rememberSnapshotListing(
      snapshotObservation.snapshots,
      knownSnapshotIds,
      snapshotIds,
      residualSnapshotIds,
      snapshotStatuses,
    );
    const resolution = resolveSnapshotRelist(
      snapshotObservation.snapshots,
      knownSnapshotIds,
      residualSnapshotIds,
      snapshotStatuses,
    );
    if (!resolution.allResolved) {
      snapshotsCleaned = false;
      absentRelistStreak = 0;
      if (allowDelete) {
        await deleteKnownSnapshots(
          knownSnapshotIds,
          snapshotStatuses,
          options,
          recordError,
          attemptedSnapshotIds,
        );
      }
      return true;
    }
    if (errors.length > 0) {
      snapshotsCleaned = false;
      absentRelistStreak = 0;
      return false;
    }
    const requiresAbsenceConfirmation = resolution.requiresAbsenceConfirmation || knownSnapshotIds.size === 0;
    if (requiresAbsenceConfirmation) {
      absentRelistStreak += 1;
      snapshotsCleaned = absentRelistStreak >= 2;
    } else {
      snapshotsCleaned = true;
    }
    return false;
  };

  let firstSandboxObservation = true;
  let attempts = 0;
  while (attempts < maxAttempts && remaining() > 0) {
    throwIfAborted();
    if (!sandboxLookupOk || !sandboxIdentityVerified) break;
    attempts += 1;

    if (staleSandbox && !sandboxDeleted) {
      try {
        const deletion = await options.adapter.deleteByName({
          credentials: options.credentials,
          name: options.name,
          signal: options.signal,
        });
        sandboxDeleted = true;
        sandboxMissing = deletion.missing;
      } catch (error) {
        recordError('stale sandbox delete', error);
      }
    }

    if (!staleSandbox && !sandboxMissing && !sandboxDeleted) {
      if (!firstSandboxObservation) {
        try {
          sandbox = await options.adapter.get({
            credentials: options.credentials,
            name: options.name,
            resume: false,
            signal: options.signal,
          });
          if (!matchesExpectedIdentity(sandbox, options.name, options.expectedTags)) {
            sandboxIdentityVerified = false;
            residualSandboxIds.add(sandboxIdentifier(sandbox) ?? options.name);
            recordError(
              'sandbox identity verification',
              new Error(`fetched sandbox does not match expected name or identity tags for ${options.name}`),
            );
            break;
          }
          rememberSnapshotId(sandbox.currentSnapshotId, knownSnapshotIds, snapshotIds, residualSnapshotIds);
        } catch (error) {
          if (isVercelNotFound(error)) {
            sandboxMissing = true;
            sandboxDeleted = true;
            sessionObservationOk = true;
          } else {
            recordError('sandbox deletion verification', error);
            sessionObservationOk = false;
          }
        }
      }
      firstSandboxObservation = false;

      if (sandbox && !sandboxMissing && !sandboxDeleted && sandboxIdentityVerified) {
        const observation = await stopAndVerifySessions(
          options.adapter,
          sandbox,
          options.signal,
          recordError,
        );
        sessionObservationOk = observation.ok;
        finalSessions = observation.sessions;
        if (!sessionObservationOk || hasNonTerminalSessions(finalSessions)) {
          residualSandboxIds.add(sandboxIdentifier(sandbox) ?? options.name);
          if (sessionObservationOk) {
            recordError('session verification', new Error('not every Sandbox session is stopped or aborted'));
          }
        }
        if (observation.stop !== undefined) {
          finalStop = observation.stop;
          rememberSnapshotId(
            observation.stop.snapshot?.id,
            knownSnapshotIds,
            snapshotIds,
            residualSnapshotIds,
          );
        }
        rememberSnapshotId(sandbox.currentSnapshotId, knownSnapshotIds, snapshotIds, residualSnapshotIds);

        const snapshotObservation = await listSnapshots(
          options.adapter,
          options.credentials,
          options.name,
          options.signal,
          recordError,
        );
        if (snapshotObservation.ok) {
          rememberSnapshotListing(
            snapshotObservation.snapshots,
            knownSnapshotIds,
            snapshotIds,
            residualSnapshotIds,
            snapshotStatuses,
          );
        }

        if (sessionObservationOk && !hasNonTerminalSessions(finalSessions) && snapshotObservation.ok) {
          try {
            await options.adapter.delete(sandbox, { signal: options.signal });
            sandboxDeleted = true;
          } catch (error) {
            if (isVercelNotFound(error)) {
              sandboxMissing = true;
              sandboxDeleted = true;
            } else recordError('sandbox delete', error);
          }
        }
      }
    }

    if (sandboxDeleted || sandboxMissing || staleSandbox) {
      const attemptedSnapshotIds = new Set<string>();
      await deleteKnownSnapshots(
        knownSnapshotIds,
        snapshotStatuses,
        options,
        recordError,
        attemptedSnapshotIds,
      );
      const followUpRelist = await processSnapshotRelist(attemptedSnapshotIds);
      if (followUpRelist && sandboxMissing && remaining() > 0) {
        await processSnapshotRelist(attemptedSnapshotIds, false);
      }
    }

    const terminal = sessionObservationOk && !hasNonTerminalSessions(finalSessions);
    if (sandboxDeleted && snapshotsCleaned && terminal) break;
    if (attempts < maxAttempts && remaining() > 0) {
      await sleep(Math.min(backoffMs * attempts, remaining()), options.signal);
    }
  }

  // A Sandbox can be reported missing before its orphan snapshot is visible.
  // Take an independent delayed relist before accepting an empty collection,
  // even when the normal retry budget ended on the first empty observation.
  if (!snapshotsCleaned && (sandboxDeleted || sandboxMissing || staleSandbox) && remaining() > 0) {
    const finalAttemptedSnapshotIds = new Set<string>();
    await deleteKnownSnapshots(
      knownSnapshotIds,
      snapshotStatuses,
      options,
      recordError,
      finalAttemptedSnapshotIds,
    );
    await processSnapshotRelist(finalAttemptedSnapshotIds);
  }

  if (!sandboxDeleted && (sandboxMissing || attempts >= maxAttempts || remaining() <= 0)) {
    residualSandboxIds.add(sandboxIdentifier(sandbox) ?? options.name);
  }
  for (const snapshotId of knownSnapshotIds) {
    if (!snapshotsCleaned) residualSnapshotIds.add(snapshotId);
  }

  const terminal = sessionObservationOk && !hasNonTerminalSessions(finalSessions);
  const verified = sandboxLookupOk && sandboxIdentityVerified && sandboxDeleted && snapshotsCleaned && terminal;
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
  stop?: VercelStopResult;
}

interface SnapshotObservation {
  snapshots: SandboxSnapshotRecord[];
  ok: boolean;
}

interface SnapshotRelistResolution {
  allResolved: boolean;
  requiresAbsenceConfirmation: boolean;
}

async function stopAndVerifySessions(
  adapter: VercelCleanupAdapter,
  sandbox: VercelCleanupSandbox,
  signal: AbortSignal | undefined,
  recordError: (operation: string, error: unknown) => void,
): Promise<SessionObservation> {
  const first = await listSessions(adapter, sandbox, signal, recordError);
  if (!first.ok) return first;
  const needsStop =
    STOPPABLE_SESSION_STATES.has(sandbox.status) ||
    first.sessions.some((session) => !TERMINAL_SESSION_STATES.has(session.status));
  if (!needsStop) return first;

  let stop: VercelStopResult | undefined;
  let stopOk = true;
  try {
    stop = await adapter.stop(sandbox, { signal });
  } catch (error) {
    stopOk = false;
    recordError('sandbox stop', error);
  }
  const after = await listSessions(adapter, sandbox, signal, recordError);
  return {
    sessions: after.sessions,
    ok: stopOk && after.ok,
    ...(stop === undefined ? {} : { stop }),
  };
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

async function deleteKnownSnapshots(
  knownSnapshotIds: Set<string>,
  snapshotStatuses: Map<string, SandboxSnapshotRecord['status']>,
  options: VercelCleanupOptions,
  recordError: (operation: string, error: unknown) => void,
  attemptedSnapshotIds?: Set<string>,
): Promise<void> {
  for (const snapshotId of knownSnapshotIds) {
    if (snapshotStatuses.get(snapshotId) === 'deleted' || attemptedSnapshotIds?.has(snapshotId)) continue;
    attemptedSnapshotIds?.add(snapshotId);
    try {
      const snapshot = await options.adapter.getSnapshot({
        credentials: options.credentials,
        snapshotId,
        signal: options.signal,
      });
      snapshotStatuses.set(snapshotId, snapshot.status);
      if (snapshot.status !== 'deleted') await snapshot.delete({ signal: options.signal });
    } catch (error) {
      if (!isVercelNotFound(error)) recordError(`snapshot delete ${snapshotId}`, error);
      // A successful delete or a 404 is not proof of absence. The next
      // complete relist alone may remove this ID from residual state.
    }
  }
}

function rememberSnapshotListing(
  snapshots: SandboxSnapshotRecord[],
  knownSnapshotIds: Set<string>,
  snapshotIds: Set<string>,
  residualSnapshotIds: Set<string>,
  snapshotStatuses: Map<string, SandboxSnapshotRecord['status']>,
): void {
  for (const snapshot of snapshots) {
    rememberSnapshotId(snapshot.id, knownSnapshotIds, snapshotIds, residualSnapshotIds);
    snapshotStatuses.set(snapshot.id, snapshot.status);
  }
}

function resolveSnapshotRelist(
  snapshots: SandboxSnapshotRecord[],
  knownSnapshotIds: Set<string>,
  residualSnapshotIds: Set<string>,
  snapshotStatuses: Map<string, SandboxSnapshotRecord['status']>,
): SnapshotRelistResolution {
  const listed = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  let allResolved = true;
  let requiresAbsenceConfirmation = false;
  for (const snapshotId of knownSnapshotIds) {
    const snapshot = listed.get(snapshotId);
    if (!snapshot) {
      residualSnapshotIds.delete(snapshotId);
      snapshotStatuses.set(snapshotId, 'deleted');
      requiresAbsenceConfirmation = true;
    } else if (snapshot.status === 'deleted') {
      residualSnapshotIds.delete(snapshotId);
    } else {
      residualSnapshotIds.add(snapshotId);
      allResolved = false;
    }
  }
  return { allResolved, requiresAbsenceConfirmation };
}

function rememberSnapshotId(
  snapshotId: unknown,
  knownSnapshotIds: Set<string>,
  snapshotIds: Set<string>,
  residualSnapshotIds: Set<string>,
): void {
  if (typeof snapshotId !== 'string' || !snapshotId.trim()) return;
  knownSnapshotIds.add(snapshotId);
  snapshotIds.add(snapshotId);
  residualSnapshotIds.add(snapshotId);
}

function matchesExpectedIdentity(
  sandbox: VercelCleanupSandbox,
  expectedName: string,
  expectedTags: VercelIdentityTags,
): boolean {
  if (sandbox.name !== expectedName || !sandbox.tags) return false;
  const expectedKeys = ['provider', 'repository', 'branch', 'version', 'identity'];
  const actualKeys = Object.keys(sandbox.tags).sort();
  const requiredKeys = [...expectedKeys].sort();
  return actualKeys.length === requiredKeys.length &&
    actualKeys.every((key, index) => key === requiredKeys[index] && sandbox.tags?.[key] === (expectedTags as unknown as Record<string, string>)[key]);
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
