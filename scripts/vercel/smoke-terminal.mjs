import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
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

function terminalLongevityMarkers() {
  const nonce = randomBytes(12).toString('hex');
  return {
    server: `provider-smoke-idle-server-${nonce}`,
    input: `provider-smoke-idle-input-${nonce}`,
    echoPrefix: `provider-smoke-idle-echo-${nonce}:`,
  };
}

function sandboxObservation(sandbox) {
  const identity = `${sandbox.id ?? ''}\0${sandbox.name ?? ''}`;
  const expiresAt = sandbox.expiresAt instanceof Date && Number.isFinite(sandbox.expiresAt.getTime())
    ? sandbox.expiresAt.toISOString()
    : null;
  return {
    sandboxFingerprint: createHash('sha256').update(identity).digest('hex').slice(0, 16),
    status: typeof sandbox.status === 'string' ? sandbox.status : 'unknown',
    expiresAt,
  };
}

/**
 * Hold one production terminal attachment without stdin traffic, then prove
 * both directions still work through that attachment. Raw Sandbox identity and
 * interactive endpoint material never enter the returned evidence.
 */
export async function runTerminalLongevity({
  sandbox,
  refreshSandbox,
  report,
  signal,
  terminalAdapter,
  idleMs,
  terminalTimeoutMs,
  recordCheck,
  now = Date.now,
  markers = terminalLongevityMarkers(),
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signalSource = new EventEmitter();
  const output = [];
  let terminalError;
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  stderr.on('data', (chunk) => output.push(chunk.toString()));

  const before = sandboxObservation(await refreshSandbox());
  const attach = terminalAdapter.attach(sandbox, {
    streams: { stdin, stdout, stderr },
    tty: false,
    signal,
    signalSource,
    timeoutExtension: false,
    getSize: () => ({ cols: 100, rows: 30 }),
    onError: (failure) => {
      terminalError = failure.message;
      return true;
    },
  });
  const capturedOutput = () => output.join('');
  const idleSeconds = Math.ceil(idleMs / 1_000);
  const encodedServerMarker = Buffer.from(markers.server).toString('base64');
  const encodedEchoPrefix = Buffer.from(markers.echoPrefix).toString('base64');
  const serverWait = waitForOutput(
    stdout,
    markers.server,
    idleMs + terminalTimeoutMs,
    signal,
    capturedOutput,
  );
  const idleStartedAtMs = now();
  stdin.write(
    `stty -echo; sleep ${idleSeconds}; printf "%s\\n" "$(printf "%s" "${encodedServerMarker}" | base64 -d)"; `
    + `IFS= read -r line; printf "%s%s\\n" "$(printf "%s" "${encodedEchoPrefix}" | base64 -d)" "$line"; stty echo\n`,
  );
  await serverWait;
  const serverObservedAtMs = now();
  const idleObservedMs = serverObservedAtMs - idleStartedAtMs;
  recordCheck(report, 'six-minute terminal idle interval', idleObservedMs >= idleMs, `observed ${idleObservedMs}ms without terminal input`);
  recordCheck(report, 'post-idle server marker', true, 'unique server marker arrived through the original attachment');

  const expectedEcho = `${markers.echoPrefix}${markers.input}`;
  const echoWait = waitForOutput(stdout, expectedEcho, terminalTimeoutMs, signal, capturedOutput);
  const inputSentAtMs = now();
  stdin.write(`${markers.input}\n`);
  await echoWait;
  const echoObservedAtMs = now();
  recordCheck(report, 'post-idle client input echo', true, 'unique client input was processed and echoed by the original attachment');

  const after = sandboxObservation(await refreshSandbox());
  const sandboxEvidenceValid = before.sandboxFingerprint === after.sandboxFingerprint
    && before.status === 'running'
    && after.status === 'running'
    && before.expiresAt !== null
    && after.expiresAt !== null;
  recordCheck(
    report,
    'terminal longevity Sandbox evidence',
    sandboxEvidenceValid,
    'sanitized identity, status, and expiresAt were recorded before and after the idle interval',
  );

  stdin.write(Buffer.from([0x1d]));
  const result = await boundedCall(
    () => attach,
    'terminal longevity completion',
    { signal, timeoutMs: terminalTimeoutMs },
  );
  const detachedByEscape = result.status === 'detached' && result.reason === 'escape';
  recordCheck(report, 'terminal longevity clean detach', detachedByEscape, terminalError ?? `terminal status=${result.status}`);
  report.terminalLongevity = {
    idleTargetMs: idleMs,
    idleStartedAt: new Date(idleStartedAtMs).toISOString(),
    idleObservedMs,
    serverObservedAt: new Date(serverObservedAtMs).toISOString(),
    inputSentAt: new Date(inputSentAtMs).toISOString(),
    echoObservedAt: new Date(echoObservedAtMs).toISOString(),
    serverMarkerObserved: true,
    clientInputEchoObserved: true,
    before,
    after,
    terminal: {
      status: result.status,
      ...(result.status === 'exited' ? { exitCode: result.code } : { reason: result.reason }),
    },
  };
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
  const readyWait = waitForOutput(stdout, readyMarker, terminalTimeoutMs, signal, capturedOutput);
  stdin.write(`printf "%s\\n" "$(printf "%s" "${encodedReadyMarker}" | base64 -d)"\n`);
  await readyWait;
  const interruptMarker = `provider-smoke-interrupted-${pathReport.label}`;
  const encodedInterruptMarker = Buffer.from(interruptMarker).toString('base64');
  const sleepMarker = `provider-smoke-sleeping-${pathReport.label}`;
  const encodedSleepMarker = Buffer.from(sleepMarker).toString('base64');
  const sleepingWait = waitForOutput(stdout, sleepMarker, terminalTimeoutMs, signal, capturedOutput);
  stdin.write(`trap 'printf "%s\\n" "$(printf "%s" "${encodedInterruptMarker}" | base64 -d)"' INT; printf "%s\\n" "$(printf "%s" "${encodedSleepMarker}" | base64 -d)"; sleep 30\n`);
  await sleepingWait;
  const outputBeforeInterrupt = capturedOutput();
  const interruptWait = waitForOutput(stdout, interruptMarker, terminalTimeoutMs, signal, capturedOutput);
  signalSource.emit('SIGINT');
  await interruptWait;
  const outputAfterInterrupt = capturedOutput().slice(outputBeforeInterrupt.length);
  const postInterruptMarker = `provider-smoke-after-interrupt-${pathReport.label}`;
  const postInterruptWait = waitForOutput(stdout, postInterruptMarker, terminalTimeoutMs, signal, capturedOutput);
  stdin.write(`printf '${postInterruptMarker}\\n'\n`);
  await postInterruptWait;
  stdin.write(Buffer.from([0x1d]));
  const result = await boundedCall(
    () => attach,
    'interactive terminal completion',
    { signal, timeoutMs: terminalTimeoutMs },
  );
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
