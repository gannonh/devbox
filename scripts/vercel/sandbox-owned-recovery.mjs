import { boundedCall } from './sandbox-cleanup.mjs';
import { sanitizeRecoveryEvidence } from './smoke-evidence.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_MS = 250;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Owned-resource recovery was aborted');
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Owned-resource recovery was aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function validateOptions({ timeoutMs, operationTimeoutMs, maxAttempts, backoffMs }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0 ||
      !Number.isInteger(maxAttempts) || maxAttempts <= 0 ||
      !Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new TypeError('owned-resource recovery deadlines and attempts must be valid');
  }
}

/**
 * Apply the final owned-resource observation to a smoke-style evidence report.
 * Transient cleanup observations belong in recovery history; only errors that
 * survive the final reconciliation are copied into cleanup.errors.
 */
export function applyOwnedRecoveryEvidence(report, recovery, redact = (value) => String(value)) {
  if (!report || typeof report !== 'object' || !report.cleanup || typeof report.cleanup !== 'object') {
    throw new TypeError('smoke evidence report with cleanup is required');
  }
  if (!recovery || typeof recovery !== 'object') throw new TypeError('owned recovery result is required');
  const safeRecovery = sanitizeRecoveryEvidence(recovery, redact);
  report.cleanup.ownedRecovery = safeRecovery;
  report.snapshots = safeRecovery.finalSnapshots;
  report.cleanup.residualNonDeletedSnapshots = safeRecovery.residualSnapshots;
  report.cleanup.snapshotsCleaned = recovery.snapshotsCleaned === true;
  report.cleanup.discoveryConverged = recovery.discoveryConverged === true;
  report.cleanup.recoverySessionProof = recovery.sessionProof === true;
  // Reconciliation history is evidence, not a transient cache. Never clear a
  // prior failure merely because a later listing happens to converge.
  if (Array.isArray(recovery.errors) && recovery.errors.length > 0) {
    report.cleanup.errors ??= [];
    report.cleanup.errors.push(...recovery.errors.map((error) => redact(error)));
    report.failed = true;
  }
  return report;
}

/**
 * Discover and clean only resources matching the caller's owned name/tag
 * query. Snapshot.list returns plain metadata in @vercel/sandbox 3.x, so the
 * deleteSnapshot callback must resolve each metadata id to a Snapshot instance
 * before invoking its instance delete method.
 *
 * Discovery deliberately runs through a bounded grace window. A create request
 * can be accepted remotely after the local create promise is aborted, so one
 * empty list is never treated as conclusive. Collection discovery failures,
 * including broad API 404s, remain errors rather than being interpreted as an
 * empty collection.
 */
export async function recoverOwnedResources({
  listSandboxes,
  recoverSandbox,
  listSnapshots,
  deleteSnapshot,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  sleep = wait,
  isNotFound = () => false,
  onObservation = () => {},
}) {
  if (typeof listSandboxes !== 'function' || typeof recoverSandbox !== 'function' ||
      typeof listSnapshots !== 'function' || typeof deleteSnapshot !== 'function') {
    throw new TypeError('owned-resource recovery callbacks are required');
  }
  validateOptions({ timeoutMs, operationTimeoutMs, maxAttempts, backoffMs });

  const deadline = Date.now() + timeoutMs;
  const permanentErrors = [];
  const sandboxOperationErrors = new Map();
  const snapshotOperationErrors = new Map();
  const recoveredSandboxes = [];
  const sessionProofSandboxes = new Set();
  const deletedSnapshots = [];
  const discoveredSandboxNames = new Set();
  let lastSandboxes = [];
  let lastSnapshots = [];
  let finalSandboxes = [];
  let finalSnapshots = [];
  let sandboxDiscoveryErrors = 0;
  let snapshotDiscoveryErrors = 0;
  let finalSandboxListingSucceeded = false;
  let finalSnapshotListingSucceeded = false;
  let attempts = 0;

  const remaining = () => Math.max(0, deadline - Date.now());
  const recordError = (operation, error) => {
    const detail = `${operation}: ${errorMessage(error)}`.slice(0, 500);
    permanentErrors.push(detail);
  };
  const recordOperationError = (map, id, operation, error) => {
    map.set(id, `${operation}: ${errorMessage(error)}`.slice(0, 500));
  };
  const call = (operation, label) => {
    const timeout = Math.min(operationTimeoutMs, remaining());
    if (timeout <= 0) throw new Error(`${label} has no remaining deadline`);
    return boundedCall(operation, label, { signal, timeoutMs: timeout });
  };

  async function listOwnedSandboxes(final = false) {
    try {
      const result = await call(
        (requestSignal) => listSandboxes({ signal: requestSignal, attempt: attempts, final }),
        final ? 'final owned Sandbox discovery' : 'owned Sandbox discovery',
      );
      return { ok: true, items: Array.isArray(result) ? result : [] };
    } catch (error) {
      sandboxDiscoveryErrors += 1;
      recordError(final ? 'final sandbox discovery' : 'sandbox discovery', error);
      return { ok: false, items: [] };
    }
  }

  async function listOwnedSnapshots(final = false) {
    try {
      const result = await call(
        (requestSignal) => listSnapshots({ signal: requestSignal, attempt: attempts, final }),
        final ? 'final owned snapshot discovery' : 'owned snapshot discovery',
      );
      return { ok: true, items: Array.isArray(result) ? result : [] };
    } catch (error) {
      snapshotDiscoveryErrors += 1;
      recordError(final ? 'final snapshot discovery' : 'snapshot discovery', error);
      return { ok: false, items: [] };
    }
  }

  async function discoverSandboxes() {
    const discovered = await listOwnedSandboxes();
    lastSandboxes = discovered.items;
    if (!discovered.ok) return;

    for (const sandbox of lastSandboxes) {
      if (!sandbox || typeof sandbox.name !== 'string' || sandbox.name.length === 0) {
        recordError('sandbox discovery', new Error('returned an unidentified resource'));
        continue;
      }
      discoveredSandboxNames.add(sandbox.name);
      try {
        const recoveryResult = await call(
          (requestSignal) => recoverSandbox(sandbox.name, { signal: requestSignal, attempt: attempts, sandbox }),
          `owned Sandbox ${sandbox.name} recovery`,
        );
        if (recoveryResult?.sessionProof === true) sessionProofSandboxes.add(sandbox.name);
        sandboxOperationErrors.delete(sandbox.name);
        if (!recoveredSandboxes.includes(sandbox.name)) recoveredSandboxes.push(sandbox.name);
      } catch (error) {
        if (isNotFound(error)) {
          sandboxOperationErrors.delete(sandbox.name);
          if (!recoveredSandboxes.includes(sandbox.name)) recoveredSandboxes.push(sandbox.name);
        } else {
          recordOperationError(sandboxOperationErrors, sandbox.name, `sandbox ${sandbox.name} recovery`, error);
        }
      }
    }
  }

  async function reconcileSnapshots() {
    const discovered = await listOwnedSnapshots();
    lastSnapshots = discovered.items;
    if (!discovered.ok) return;

    for (const snapshot of lastSnapshots) {
      if (!snapshot || typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
        recordError('snapshot discovery', new Error('returned an unidentified resource'));
        continue;
      }
      if (snapshot.status === 'deleted') {
        snapshotOperationErrors.delete(snapshot.id);
        continue;
      }
      try {
        await call(
          (requestSignal) => deleteSnapshot(snapshot, { signal: requestSignal, attempt: attempts }),
          `owned snapshot ${snapshot.id} deletion`,
        );
        snapshotOperationErrors.delete(snapshot.id);
        if (!deletedSnapshots.includes(snapshot.id)) deletedSnapshots.push(snapshot.id);
      } catch (error) {
        if (isNotFound(error)) {
          snapshotOperationErrors.delete(snapshot.id);
          if (!deletedSnapshots.includes(snapshot.id)) deletedSnapshots.push(snapshot.id);
        } else {
          recordOperationError(snapshotOperationErrors, snapshot.id, `snapshot ${snapshot.id} cleanup`, error);
        }
      }
    }
  }

  while (attempts < maxAttempts && remaining() > 0) {
    attempts += 1;
    await discoverSandboxes();
    await reconcileSnapshots();
    onObservation({ attempt: attempts, sandboxes: lastSandboxes, snapshots: lastSnapshots });
    if (attempts >= maxAttempts || remaining() <= 0) break;
    const delay = Math.min(backoffMs * attempts, remaining());
    if (delay > 0) {
      try {
        await sleep(delay, signal);
      } catch (error) {
        recordError('owned-resource retry delay', error);
        break;
      }
    }
  }

  // Always take an independent final listing. A successful recovery callback
  // is not evidence that the collection has converged; the owned name/id must
  // disappear from this fresh observation before residuals can be suppressed.
  if (remaining() > 0) {
    const finalSandboxResult = await listOwnedSandboxes(true);
    finalSandboxes = finalSandboxResult.items;
    finalSandboxListingSucceeded = finalSandboxResult.ok;
    const finalSnapshotResult = await listOwnedSnapshots(true);
    finalSnapshots = finalSnapshotResult.items;
    finalSnapshotListingSucceeded = finalSnapshotResult.ok;
  }

  const malformedFinalSandboxes = finalSandboxes.filter(
    (sandbox) => !sandbox || typeof sandbox.name !== 'string' || sandbox.name.length === 0,
  );
  const malformedFinalSnapshots = finalSnapshots.filter(
    (snapshot) => !snapshot || typeof snapshot.id !== 'string' || snapshot.id.length === 0,
  );
  for (const sandbox of malformedFinalSandboxes) {
    recordError('final sandbox discovery', new Error(`returned an unidentified resource: ${errorMessage(sandbox)}`));
  }
  for (const snapshot of malformedFinalSnapshots) {
    recordError('final snapshot discovery', new Error(`returned an unidentified resource: ${errorMessage(snapshot)}`));
  }
  for (const sandbox of finalSandboxes) {
    if (sandbox && typeof sandbox.name === 'string') discoveredSandboxNames.add(sandbox.name);
  }
  const residualSandboxes = finalSandboxes
    .filter((sandbox) => sandbox && typeof sandbox.name === 'string' && sandbox.name.length > 0)
    .map((sandbox) => ({ name: sandbox.name, status: sandbox.status }));
  const residualSnapshots = finalSnapshots
    .filter((snapshot) => snapshot && typeof snapshot.id === 'string' && snapshot.id.length > 0 && snapshot.status !== 'deleted')
    .map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));

  for (const residual of residualSandboxes) {
    const operationError = sandboxOperationErrors.get(residual.name);
    if (operationError) permanentErrors.push(operationError);
    recordError('sandbox residual', new Error(`${residual.name} remains ${residual.status ?? 'present'}`));
  }
  for (const residual of residualSnapshots) {
    const operationError = snapshotOperationErrors.get(residual.id);
    if (operationError) permanentErrors.push(operationError);
    recordError('snapshot residual', new Error(`${residual.id} remains ${residual.status}`));
  }
  const errors = permanentErrors;

  return {
    attempts,
    discoveryConverged: attempts > 0 && finalSandboxListingSucceeded && sandboxDiscoveryErrors === 0 && malformedFinalSandboxes.length === 0 && residualSandboxes.length === 0,
    recoveredSandboxes,
    sessionProof: sessionProofSandboxes.size > 0,
    sessionProofSandboxes: [...sessionProofSandboxes],
    discoveredSandboxes: [...discoveredSandboxNames],
    finalSandboxes,
    residualSandboxes,
    deletedSnapshots,
    finalSnapshots,
    residualSnapshots,
    snapshotsCleaned: attempts > 0 && finalSnapshotListingSucceeded && snapshotDiscoveryErrors === 0 && malformedFinalSnapshots.length === 0 && residualSnapshots.length === 0,
    errors,
  };
}
