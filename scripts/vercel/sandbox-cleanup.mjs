const TERMINAL_SESSION_STATES = new Set(['stopped', 'aborted']);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_MS = 250;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Sandbox cleanup was aborted');
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
      reject(signal.reason ?? new Error('Sandbox cleanup was aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function boundedCall(operation, label, { signal, timeoutMs }) {
  throwIfAborted(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} has no remaining deadline`);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const abortListener = () => rejectAbort(signal.reason ?? new Error(`${label} was aborted`));
  signal?.addEventListener('abort', abortListener, { once: true });
  const operationResult = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([operationResult, aborted, timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', abortListener);
  }
}

function isRunning(states) {
  return states.some((session) => !TERMINAL_SESSION_STATES.has(session.status));
}

/**
 * Verify eventual Sandbox deletion without ever resuming the looked-up VM.
 *
 * The callbacks are injected so this policy can be exercised without cloud
 * credentials. Every lookup requests resume:false; transient running/stopping
 * states trigger another stop/delete attempt before a bounded retry.
 */
export async function verifySandboxDeleted({
  getSandbox,
  listSessions,
  stopSandbox,
  deleteSandbox,
  isNotFound = (error) => Boolean(error?.notFound),
  isTransient = () => false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  signal,
  sleep = wait,
  onObservation = () => {},
  onMissing = () => {},
  onRecovery = () => {},
}) {
  if (typeof getSandbox !== 'function' || typeof listSessions !== 'function' ||
      typeof stopSandbox !== 'function' || typeof deleteSandbox !== 'function') {
    throw new TypeError('Sandbox deletion verification callbacks are required');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new TypeError('Sandbox deletion verification deadlines must be positive');
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const errors = [];
  let attempts = 0;
  let lastStates = [];

  const remaining = () => Math.max(0, deadline - Date.now());
  const recordError = (operation, error) => {
    const detail = `${operation}: ${errorMessage(error)}`.slice(0, 500);
    errors.push(detail);
    onRecovery({ operation, outcome: 'failed', detail });
  };

  async function inspect(phase) {
    const getTimeout = Math.min(operationTimeoutMs, remaining());
    if (getTimeout <= 0) return { kind: 'deadline' };
    let target;
    try {
      target = await boundedCall(
        (requestSignal) => getSandbox({ resume: false, signal: requestSignal }),
        'post-delete lookup',
        { signal, timeoutMs: getTimeout },
      );
    } catch (error) {
      if (isNotFound(error)) return { kind: 'missing' };
      if (isTransient(error)) return { kind: 'transient' };
      recordError('post-delete lookup', error);
      return { kind: 'error' };
    }
    const listTimeout = Math.min(operationTimeoutMs, remaining());
    if (listTimeout <= 0) return { kind: 'deadline', target };
    try {
      const states = await boundedCall(
        (requestSignal) => listSessions(target, { signal: requestSignal, phase }),
        'post-delete session enumeration',
        { signal, timeoutMs: listTimeout },
      );
      lastStates = Array.isArray(states) ? states : [];
      onObservation(lastStates, phase, attempts);
      return { kind: 'present', target, states: lastStates };
    } catch (error) {
      recordError('post-delete session enumeration', error);
      return { kind: 'error', target };
    }
  }

  async function recover(target, states, finalAttempt = false) {
    const running = isRunning(states);
    if (running) {
      try {
        await boundedCall(
          (requestSignal) => stopSandbox(target, { signal: requestSignal }),
          'post-delete stop recovery',
          { signal, timeoutMs: Math.min(operationTimeoutMs, remaining()) },
        );
        onRecovery({ operation: 'stop', outcome: 'passed', finalAttempt });
      } catch (error) {
        if (isNotFound(error)) onRecovery({ operation: 'stop', outcome: 'not-found', finalAttempt });
        else if (isTransient(error)) onRecovery({ operation: 'stop', outcome: 'transient', finalAttempt });
        else recordError('post-delete stop recovery', error);
      }
    }
    if (remaining() <= 0) return;
    try {
      await boundedCall(
        (requestSignal) => deleteSandbox(target, { signal: requestSignal }),
        'post-delete delete recovery',
        { signal, timeoutMs: Math.min(operationTimeoutMs, remaining()) },
      );
      onRecovery({ operation: 'delete', outcome: 'passed', finalAttempt });
    } catch (error) {
      if (isNotFound(error)) onRecovery({ operation: 'delete', outcome: 'not-found', finalAttempt });
      else if (isTransient(error)) onRecovery({ operation: 'delete', outcome: 'transient', finalAttempt });
      else recordError('post-delete delete recovery', error);
    }
  }

  while (attempts < maxAttempts && remaining() > 0) {
    attempts += 1;
    const result = await inspect('after-delete-lookup');
    if (result.kind === 'missing') {
      onMissing('after-delete-missing', attempts);
      return { verified: true, noRunningSession: true, attempts, errors };
    }
    if (result.kind === 'present') await recover(result.target, result.states);
    if (remaining() <= 0 || attempts >= maxAttempts) break;
    const delay = Math.min(backoffMs * attempts, Math.max(0, remaining()));
    if (delay > 0) {
      try {
        await sleep(delay, signal);
      } catch (error) {
        recordError('post-delete retry delay', error);
        break;
      }
    }
  }

  // A final non-resuming lookup and re-enumeration is mandatory. If the
  // eventual-consistency window outlived the normal retries, make one last
  // stop/delete attempt before failing closed.
  if (remaining() > 0) {
    const final = await inspect('after-delete-final');
    if (final.kind === 'missing') {
      onMissing('after-delete-missing', attempts);
      return { verified: true, noRunningSession: true, attempts, errors };
    }
    if (final.kind === 'present') {
      await recover(final.target, final.states, true);
      if (remaining() > 0) {
        const recheck = await inspect('after-delete-final-recheck');
        if (recheck.kind === 'missing') {
          onMissing('after-delete-missing', attempts);
          return { verified: true, noRunningSession: true, attempts, errors };
        }
        if (recheck.kind === 'present') lastStates = recheck.states;
      }
    }
  }

  return {
    verified: false,
    noRunningSession: lastStates.length > 0 && !isRunning(lastStates),
    attempts,
    errors,
  };
}

export { TERMINAL_SESSION_STATES };
