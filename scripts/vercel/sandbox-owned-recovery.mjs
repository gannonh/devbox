import { boundedCall } from './sandbox-cleanup.mjs';

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
 * Discover and clean only resources matching the caller's owned name/tag
 * query. Snapshot.list returns plain metadata in @vercel/sandbox 3.x, so the
 * deleteSnapshot callback must resolve each metadata id to a Snapshot instance
 * before invoking its instance delete method.
 *
 * Discovery deliberately runs through a bounded grace window. A create request
 * can be accepted remotely after the local create promise is aborted, so one
 * empty list or 404 is never treated as conclusive.
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
  const errors = [];
  const recoveredSandboxes = [];
  const deletedSnapshots = [];
  const discoveredSandboxNames = new Set();
  const recoveredSandboxNames = new Set();
  let lastSandboxes = [];
  let lastSnapshots = [];
  let sandboxDiscoveryErrors = 0;
  let snapshotDiscoveryErrors = 0;
  let attempts = 0;

  const remaining = () => Math.max(0, deadline - Date.now());
  const recordError = (operation, error) => {
    const detail = `${operation}: ${errorMessage(error)}`.slice(0, 500);
    errors.push(detail);
  };
  const call = (operation, label) => {
    const timeout = Math.min(operationTimeoutMs, remaining());
    if (timeout <= 0) throw new Error(`${label} has no remaining deadline`);
    return boundedCall(operation, label, { signal, timeoutMs: timeout });
  };

  async function discoverSandboxes() {
    try {
      const result = await call(
        (requestSignal) => listSandboxes({ signal: requestSignal, attempt: attempts }),
        'owned Sandbox discovery',
      );
      lastSandboxes = Array.isArray(result) ? result : [];
    } catch (error) {
      if (isNotFound(error)) {
        lastSandboxes = [];
      } else {
        sandboxDiscoveryErrors += 1;
        lastSandboxes = [];
        recordError('sandbox discovery', error);
      }
    }

    for (const sandbox of lastSandboxes) {
      if (!sandbox || typeof sandbox.name !== 'string' || sandbox.name.length === 0) {
        recordError('sandbox discovery', new Error('returned an unidentified resource'));
        continue;
      }
      discoveredSandboxNames.add(sandbox.name);
      if (recoveredSandboxNames.has(sandbox.name)) continue;
      try {
        await call(
          (requestSignal) => recoverSandbox(sandbox.name, { signal: requestSignal, attempt: attempts, sandbox }),
          `owned Sandbox ${sandbox.name} recovery`,
        );
        recoveredSandboxNames.add(sandbox.name);
        if (!recoveredSandboxes.includes(sandbox.name)) recoveredSandboxes.push(sandbox.name);
      } catch (error) {
        if (isNotFound(error)) {
          recoveredSandboxNames.add(sandbox.name);
          if (!recoveredSandboxes.includes(sandbox.name)) recoveredSandboxes.push(sandbox.name);
        } else {
          recordError(`sandbox ${sandbox.name} recovery`, error);
        }
      }
    }
  }

  async function reconcileSnapshots() {
    try {
      const result = await call(
        (requestSignal) => listSnapshots({ signal: requestSignal, attempt: attempts }),
        'owned snapshot discovery',
      );
      lastSnapshots = Array.isArray(result) ? result : [];
    } catch (error) {
      if (isNotFound(error)) {
        lastSnapshots = [];
      } else {
        snapshotDiscoveryErrors += 1;
        lastSnapshots = [];
        recordError('snapshot discovery', error);
      }
      return;
    }

    for (const snapshot of lastSnapshots) {
      if (!snapshot || typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
        recordError('snapshot discovery', new Error('returned an unidentified resource'));
        continue;
      }
      if (snapshot.status === 'deleted') continue;
      try {
        await call(
          (requestSignal) => deleteSnapshot(snapshot, { signal: requestSignal, attempt: attempts }),
          `owned snapshot ${snapshot.id} deletion`,
        );
        if (!deletedSnapshots.includes(snapshot.id)) deletedSnapshots.push(snapshot.id);
      } catch (error) {
        if (isNotFound(error)) {
          if (!deletedSnapshots.includes(snapshot.id)) deletedSnapshots.push(snapshot.id);
        } else {
          recordError(`snapshot ${snapshot.id} cleanup`, error);
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

  const residualSandboxes = lastSandboxes
    .filter((sandbox) => sandbox && typeof sandbox.name === 'string' && !recoveredSandboxNames.has(sandbox.name))
    .map((sandbox) => ({ name: sandbox.name, status: sandbox.status }));
  const residualSnapshots = lastSnapshots
    .filter((snapshot) => snapshot && snapshot.status !== 'deleted')
    .map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
  if (residualSnapshots.length > 0) {
    for (const snapshot of residualSnapshots) {
      recordError('snapshot residual', new Error(`${snapshot.id} remains ${snapshot.status}`));
    }
  }

  return {
    attempts,
    discoveryConverged: attempts > 0 && sandboxDiscoveryErrors === 0 && residualSandboxes.length === 0,
    recoveredSandboxes,
    discoveredSandboxes: [...discoveredSandboxNames],
    residualSandboxes,
    deletedSnapshots,
    residualSnapshots,
    snapshotsCleaned: attempts > 0 && snapshotDiscoveryErrors === 0 && residualSnapshots.length === 0,
    errors,
  };
}
