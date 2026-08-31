const DEFAULT_TIMEOUT_MS = 10_000;

function assertTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('HTTP probe timeout must be a positive finite number');
  }
  return Math.ceil(timeoutMs);
}

/**
 * Fetch one endpoint with an explicit abortable deadline.
 *
 * The caller may supply a parent signal as the fourth argument or through
 * RequestInit.signal. The helper owns the per-request controller so a stalled
 * response cannot keep the smoke gate from reaching cleanup.
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS, parentSignal) {
  return requestWithTimeout(url, init, timeoutMs, parentSignal, (response) => response);
}

export async function fetchTextWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS, parentSignal) {
  return requestWithTimeout(url, init, timeoutMs, parentSignal, async (response) => ({
    response,
    body: await response.text(),
  }));
}

async function requestWithTimeout(url, init, timeoutMs, parentSignal, consume) {
  const deadlineMs = assertTimeout(timeoutMs);
  const inheritedSignal = parentSignal ?? init.signal;
  const requestInit = { ...init };
  delete requestInit.signal;
  const controller = new AbortController();
  let timer;
  let timedOut = false;

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(inheritedSignal?.reason);
  };
  if (inheritedSignal?.aborted) abortFromParent();
  inheritedSignal?.addEventListener('abort', abortFromParent, { once: true });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`HTTP request timed out after ${deadlineMs}ms`));
  }, deadlineMs);

  try {
    const response = await fetch(url, { ...requestInit, signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (timedOut) {
      throw new Error(`HTTP request timed out after ${deadlineMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    inheritedSignal?.removeEventListener('abort', abortFromParent);
  }
}

export { DEFAULT_TIMEOUT_MS };
