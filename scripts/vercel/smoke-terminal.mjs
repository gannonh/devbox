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
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signalSource = new EventEmitter();
  let terminalError;
  const output = [];
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  stderr.on('data', (chunk) => output.push(chunk.toString()));

  const attach = terminalAdapter.attach(sandbox, {
    streams: { stdin, stdout, stderr },
    tty: false,
    signal,
    signalSource,
    cwd: cloneCwd,
    timeoutExtension: false,
    getSize: () => ({ cols: 100, rows: 30 }),
    onError: (failure) => {
      terminalError = failure.message;
      return true;
    },
  });
  const capturedOutput = () => output.join('');
  const readyMarker = `provider-smoke-ready-${pathReport.label}`;
  const encodedReadyMarker = Buffer.from(readyMarker).toString('base64');
  stdin.write(`printf "%s\\n" "$(printf "%s" "${encodedReadyMarker}" | base64 -d)"\n`);
  await waitForOutput(stdout, readyMarker, terminalTimeoutMs, signal, capturedOutput);
  const interruptMarker = `provider-smoke-interrupted-${pathReport.label}`;
  const encodedInterruptMarker = Buffer.from(interruptMarker).toString('base64');
  const sleepMarker = `provider-smoke-sleeping-${pathReport.label}`;
  const encodedSleepMarker = Buffer.from(sleepMarker).toString('base64');
  stdin.write(`trap 'printf "%s\\n" "$(printf "%s" "${encodedInterruptMarker}" | base64 -d)"' INT; printf "%s\\n" "$(printf "%s" "${encodedSleepMarker}" | base64 -d)"; sleep 30\n`);
  await waitForOutput(stdout, sleepMarker, terminalTimeoutMs, signal, capturedOutput);
  const outputBeforeInterrupt = capturedOutput();
  signalSource.emit('SIGINT');
  await waitForOutput(stdout, interruptMarker, terminalTimeoutMs, signal, capturedOutput);
  const outputAfterInterrupt = capturedOutput().slice(outputBeforeInterrupt.length);
  stdin.write(`printf 'provider-smoke-after-interrupt-${pathReport.label}\\n'\nexit\n`);
  const result = await boundedCall(
    () => attach,
    'interactive terminal completion',
    { signal, timeoutMs: terminalTimeoutMs },
  );
  recordCheck(pathReport, 'openInteractive terminal', result.status === 'exited' && result.code === 0, terminalError ?? 'terminal completed');
  recordCheck(pathReport, 'Ctrl-C terminal protocol', outputAfterInterrupt.includes(interruptMarker), 'remote trap observed SIGINT after it was sent through the terminal adapter');
  pathReport.terminal = {
    status: result.status,
    ...(result.status === 'exited' ? { exitCode: result.code } : { reason: result.reason }),
    outputMarkers: output.filter((value) => value.includes('provider-smoke-')).length,
  };
}
