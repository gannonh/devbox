import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { boundedCall } from './sandbox-cleanup.mjs';

/**
 * Wait for a marker without leaving a data listener or timeout behind. The
 * listener is installed before the captured-output check so a marker emitted
 * during the check cannot fall through the race window.
 */
export function waitForOutput(
  stream,
  marker,
  timeoutMs,
  signal,
  currentOutput = () => '',
  scheduler = {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  },
) {
  return new Promise((resolve, reject) => {
    let output = '';
    let timer;
    let settled = false;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      stream.removeListener('data', onData);
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) scheduler.clearTimeout(timer);
      timer = undefined;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error instanceof Error) reject(error);
      else resolve(output);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) finish();
    };
    const onAbort = () => finish(signal?.reason ?? new Error('terminal output wait aborted'));

    stream.on('data', onData);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = scheduler.setTimeout(() => finish(new Error(`terminal output did not contain ${marker}`)), timeoutMs);

    try {
      // Chunks emitted while the snapshot was taken are already accumulated in
      // `output`; merge them after the captured snapshot instead of overwriting
      // them. When the snapshot already ends with those chunks (it was read
      // after they were emitted), keep it as-is so nothing is duplicated.
      const captured = currentOutput();
      output = captured.endsWith(output) ? captured : captured + output;
    } catch (error) {
      finish(error);
      return;
    }
    if (output.includes(marker)) finish();
  });
}

/** Run the production terminal adapter through the smoke's ready/interrupt path. */
export async function runInteractiveTerminal({
  sandbox,
  pathReport,
  signal,
  terminalAdapter,
  cloneCwd,
  terminalTimeoutMs,
  recordCheck,
  readyRetryIntervalMs = 2_000,
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signalSource = new EventEmitter();
  let terminalError;
  const output = [];
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  stderr.on('data', (chunk) => output.push(chunk.toString()));

  const sessionController = new AbortController();
  const abortSession = (reason) => {
    if (sessionController.signal.aborted) return;
    sessionController.abort(reason instanceof Error ? reason : new Error(String(reason)));
  };
  const onParentAbort = () => abortSession(signal?.reason ?? new Error('terminal session aborted'));
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener('abort', onParentAbort, { once: true });
  const sessionSignal = sessionController.signal;

  let protocolComplete = false;
  const attach = terminalAdapter.attach(sandbox, {
    streams: { stdin, stdout, stderr },
    tty: false,
    signal: sessionSignal,
    signalSource,
    cwd: cloneCwd,
    getSize: () => ({ cols: 100, rows: 30 }),
    onError: (failure) => {
      terminalError = failure.message;
      return true;
    },
  });
  const attachWatch = Promise.resolve(attach).then((result) => {
    if (!protocolComplete && !(result.status === 'detached' && result.reason === 'escape')) {
      abortSession(new Error(
        terminalError ?? `interactive terminal settled early (${result.status}${result.reason ? `/${result.reason}` : ''})`,
      ));
    }
    return result;
  }, (error) => {
    abortSession(error instanceof Error ? error : new Error(String(error)));
    throw error;
  });

  const capturedOutput = () => output.join('');
  // Keep marker waits under the outer stage budget so a missing ready marker
  // surfaces as itself instead of the opaque `terminal-resumed timed out` label.
  const markerTimeoutMs = Math.max(1_000, terminalTimeoutMs - 5_000);
  const readyMarker = `provider-smoke-ready-${pathReport.label}`;
  const encodedReadyMarker = Buffer.from(readyMarker).toString('base64');
  const readyCommand = `printf "%s\\n" "$(printf "%s" "${encodedReadyMarker}" | base64 -d)"\n`;
  const readyWait = waitForOutput(stdout, readyMarker, markerTimeoutMs, sessionSignal, capturedOutput);
  stdin.write(readyCommand);
  const readyRetry = setInterval(() => {
    if (sessionSignal.aborted || capturedOutput().includes(readyMarker)) return;
    stdin.write(readyCommand);
  }, readyRetryIntervalMs);
  try {
    await readyWait;
  } finally {
    clearInterval(readyRetry);
  }
  const interruptMarker = `provider-smoke-interrupted-${pathReport.label}`;
  const encodedInterruptMarker = Buffer.from(interruptMarker).toString('base64');
  const sleepMarker = `provider-smoke-sleeping-${pathReport.label}`;
  const encodedSleepMarker = Buffer.from(sleepMarker).toString('base64');
  const sleepingWait = waitForOutput(stdout, sleepMarker, markerTimeoutMs, sessionSignal, capturedOutput);
  stdin.write(`trap 'printf "%s\\n" "$(printf "%s" "${encodedInterruptMarker}" | base64 -d)"' INT; printf "%s\\n" "$(printf "%s" "${encodedSleepMarker}" | base64 -d)"; sleep 30\n`);
  await sleepingWait;
  const outputBeforeInterrupt = capturedOutput();
  const interruptWait = waitForOutput(stdout, interruptMarker, markerTimeoutMs, sessionSignal, capturedOutput);
  signalSource.emit('SIGINT');
  await interruptWait;
  const outputAfterInterrupt = capturedOutput().slice(outputBeforeInterrupt.length);
  const postInterruptMarker = `provider-smoke-after-interrupt-${pathReport.label}`;
  const postInterruptWait = waitForOutput(stdout, postInterruptMarker, markerTimeoutMs, sessionSignal, capturedOutput);
  stdin.write(`printf '${postInterruptMarker}\\n'\n`);
  await postInterruptWait;
  protocolComplete = true;
  stdin.write(Buffer.from([0x1d]));
  const result = await boundedCall(
    () => attachWatch,
    'interactive terminal completion',
    { signal: sessionSignal, timeoutMs: terminalTimeoutMs },
  );
  signal?.removeEventListener('abort', onParentAbort);
  const detachedByEscape = result.status === 'detached' && result.reason === 'escape';
  recordCheck(pathReport, 'openInteractive terminal', detachedByEscape, terminalError ?? `terminal status=${result.status}`);
  recordCheck(pathReport, 'Ctrl-C terminal protocol', outputAfterInterrupt.includes(interruptMarker), 'remote trap observed SIGINT after it was sent through the terminal adapter');
  recordCheck(pathReport, 'Ctrl-] terminal protocol', detachedByEscape, 'terminal adapter detached with the production escape reason after byte 0x1d');
  pathReport.terminal = {
    status: result.status,
    ...(result.status === 'exited' ? { exitCode: result.code } : { reason: result.reason }),
    outputMarkers: output.filter((value) => value.includes('provider-smoke-')).length,
  };
}
