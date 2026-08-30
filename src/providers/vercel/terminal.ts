import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { redactSecrets } from './redaction.js';
import {
  BoundedBufferQueue,
  DEFAULT_BACKPRESSURE_TIMEOUT_MS,
  DEFAULT_MAX_PENDING_INPUT_BYTES,
  DEFAULT_MAX_PENDING_OUTPUT_BYTES,
  MAX_BUFFER_LIMIT_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  pauseSocket,
  restoreReadableState,
  resumeSocket,
  validateByteLimit,
  validateTimeoutLimit,
} from './terminal-flow.js';

export interface VercelTerminalScheduler {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type VercelTerminalHeartbeatScheduler = VercelTerminalScheduler;

const OPEN = 1;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_DETACH_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const TERM = 'xterm-256color';
const PS1 = `▲ \x01\x1b[2m\x02$PWD/\x01\x1b[0m\x02 `;

export interface VercelTerminalWebSocket extends EventEmitter {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  readonly isPaused?: boolean;
  send(data: Buffer | string, callback?: (error?: Error) => void): void | boolean;
  ping(callback?: (error?: Error) => void): void;
  pause?: () => void;
  resume?: () => void;
  close(code?: number, reason?: string): void;
}

export interface VercelTerminalInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  readonly readableFlowing?: boolean | null;
}

export interface VercelTerminalOutput extends NodeJS.WritableStream {
  readonly columns?: number;
  readonly rows?: number;
}

export interface VercelTerminalStreams {
  stdin: VercelTerminalInput;
  stdout: VercelTerminalOutput;
  stderr: NodeJS.WritableStream;
}

export interface VercelTerminalSize {
  cols: number;
  rows: number;
}

export interface VercelInteractiveSandbox {
  readonly cwd?: string;
  readonly createdAt?: Date;
  readonly expiresAt?: Date;
  readonly timeout?: number;
  openInteractive(options?: { signal?: AbortSignal }): Promise<{
    url: string;
    token: string;
  }>;
}

export interface VercelTerminalFailure {
  readonly cause: Error;
  readonly message: string;
}

export type VercelTerminalResult =
  | { status: 'exited'; code: number }
  | {
    status: 'detached';
    reason: 'close' | 'error' | 'abort' | 'escape' | 'eof' | 'signal';
    error?: VercelTerminalFailure;
  };

export interface VercelTerminalOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  streams?: VercelTerminalStreams;
  /** Provider-neutral TTY fact; avoids consulting a global process stream. */
  tty?: boolean;
  signal?: AbortSignal;
  program?: VercelTerminalProgram;
  signalSource?: EventEmitter;
  detachSignals?: readonly ('SIGTERM' | 'SIGHUP')[];
  getSize?: () => VercelTerminalSize;
  connectionTimeoutMs?: number;
  connectionTimeoutScheduler?: VercelTerminalScheduler;
  heartbeatIntervalMs?: number;
  heartbeatScheduler?: VercelTerminalHeartbeatScheduler;
  /** Return true to suppress the adapter's direct stderr rendering. */
  onError?: (failure: VercelTerminalFailure) => boolean;
  maxPendingInputBytes?: number;
  maxPendingOutputBytes?: number;
  backpressureTimeoutMs?: number;
}

export interface VercelTerminalProgram {
  command: string;
  args?: readonly string[];
}

export interface VercelTerminalAdapterDependencies {
  createWebSocket?: (url: string, options: { maxPayload: number }) => VercelTerminalWebSocket;
  streams?: VercelTerminalStreams;
  signalSource?: EventEmitter;
}

export interface VercelTerminalAdapter {
  attach(
    sandbox: VercelInteractiveSandbox,
    options?: VercelTerminalOptions,
  ): Promise<VercelTerminalResult>;
}

export function createVercelTerminalAdapter(
  dependencies: VercelTerminalAdapterDependencies = {},
): VercelTerminalAdapter {
  const createWebSocket = dependencies.createWebSocket ?? ((url: string, options: { maxPayload: number }) =>
    new WebSocket(url, options) as unknown as VercelTerminalWebSocket);
  const defaultStreams = dependencies.streams;
  const defaultSignalSource = dependencies.signalSource ?? process;

  return {
    attach: (sandbox, options = {}) => {
      const streams = options.streams ?? defaultStreams;
      if (!streams) return Promise.resolve({ status: 'detached', reason: 'error' as const });
      return attachTerminal({
        sandbox,
        options,
        createWebSocket,
        streams,
        signalSource: options.signalSource ?? defaultSignalSource,
      });
    },
  };
}

async function attachTerminal(input: {
  sandbox: VercelInteractiveSandbox;
  options: VercelTerminalOptions;
  createWebSocket: (url: string, options: { maxPayload: number }) => VercelTerminalWebSocket;
  streams: VercelTerminalStreams;
  signalSource: EventEmitter;
}): Promise<VercelTerminalResult> {
  const { sandbox, options, createWebSocket, streams, signalSource } = input;
  const reportFailure = (error: unknown, secrets: readonly string[] = []): VercelTerminalFailure => {
    const failure = createTerminalFailure(error, secrets);
    if (options.onError?.(failure) !== true) writeError(streams.stderr, failure.message);
    return failure;
  };
  const failureResult = (failure: VercelTerminalFailure): VercelTerminalResult => ({
    status: 'detached',
    reason: 'error',
    ...(options.onError === undefined ? {} : { error: failure }),
  });
  let interactive: Awaited<ReturnType<VercelInteractiveSandbox['openInteractive']>>;
  try {
    interactive = await sandbox.openInteractive({ signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) return { status: 'detached', reason: 'abort' };
    return failureResult(reportFailure(error));
  }
  if (options.signal?.aborted) return { status: 'detached', reason: 'abort' };

  let connectionTimeoutMs: number;
  try {
    connectionTimeoutMs = validateTimeoutLimit(
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      'connection timeout',
    );
  } catch (error) {
    return failureResult(reportFailure(error, [interactive.token]));
  }
  const connectionTimeoutScheduler = options.connectionTimeoutScheduler ?? {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } satisfies VercelTerminalScheduler;

  let socket: VercelTerminalWebSocket | undefined;
  let removeEarlyMessageListener = () => {};
  let removeSocketErrorGuard = () => {};
  const earlyMessages: Array<{ data: unknown; isBinary: boolean }> = [];
  let earlyMessageBytes = 0;
  let earlyMessageOverflow = false;
  const onEarlyMessage = (data: unknown, isBinary: boolean) => {
    let size: number;
    try {
      size = toBuffer(data).length;
    } catch {
      size = 0;
    }
    if (earlyMessageBytes + size > MAX_BUFFER_LIMIT_BYTES) {
      earlyMessageOverflow = true;
      return;
    }
    earlyMessageBytes += size;
    earlyMessages.push({ data, isBinary });
  };
  try {
    const socketUrl = new URL(interactive.url);
    const tokenQuery = `token=${encodeURIComponent(interactive.token)}`;
    socketUrl.search = socketUrl.search
      ? `${socketUrl.search}&${tokenQuery}`
      : `?${tokenQuery}`;
    socket = createWebSocket(socketUrl.toString(), { maxPayload: MAX_BUFFER_LIMIT_BYTES });
    removeSocketErrorGuard = installCloseErrorGuard(socket);
    socket.on('message', onEarlyMessage);
    removeEarlyMessageListener = () => socket?.removeListener('message', onEarlyMessage);
    removeSocketErrorGuard = await waitForOpen(socket, options.signal, {
      errorGuard: removeSocketErrorGuard,
      timeoutMs: connectionTimeoutMs,
      scheduler: connectionTimeoutScheduler,
    });
  } catch (error) {
    removeEarlyMessageListener();
    closeSocket(socket);
    if (options.signal?.aborted) return { status: 'detached', reason: 'abort' };
    return failureResult(reportFailure(error, [interactive.token]));
  }
  if (options.signal?.aborted) {
    removeEarlyMessageListener();
    closeSocket(socket);
    return { status: 'detached', reason: 'abort' };
  }
  if (!socket) {
    return failureResult(reportFailure(new Error('WebSocket client was not created')));
  }

  const getSize = options.getSize ?? (() => ({
    cols: terminalDimension(streams.stdout.columns, DEFAULT_COLUMNS),
    rows: terminalDimension(streams.stdout.rows, DEFAULT_ROWS),
  }));
  let startFrame: string;
  try {
    const size = getSize();
    validateSize(size);
    const env = { TERM, PS1, ...(options.env ?? {}) };
    const program = options.program ?? { command: 'sh', args: [] };
    if (!program.command.trim()) throw new Error('Terminal program command must not be empty');
    startFrame = JSON.stringify({
      type: 'start',
      command: program.command,
      args: [...(program.args ?? [])],
      env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      cwd: options.cwd ?? sandbox.cwd ?? '/vercel/sandbox',
      cols: size.cols,
      rows: size.rows,
    });
  } catch (error) {
    const failure = reportFailure(error, [interactive.token]);
    removeEarlyMessageListener();
    closeSocket(socket);
    return failureResult(failure);
  }

  let maxPendingInputBytes: number;
  let maxPendingOutputBytes: number;
  let backpressureTimeoutMs: number;
  let heartbeatIntervalMs: number;
  try {
    maxPendingInputBytes = validateByteLimit(
      options.maxPendingInputBytes ?? DEFAULT_MAX_PENDING_INPUT_BYTES,
      'input backpressure limit',
    );
    maxPendingOutputBytes = validateByteLimit(
      options.maxPendingOutputBytes ?? DEFAULT_MAX_PENDING_OUTPUT_BYTES,
      'output backpressure limit',
    );
    backpressureTimeoutMs = validateTimeoutLimit(
      options.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS,
    );
    heartbeatIntervalMs = validateTimeoutLimit(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeat interval',
    );
  } catch (error) {
    const failure = reportFailure(error, [interactive.token]);
    removeEarlyMessageListener();
    closeSocket(socket);
    return failureResult(failure);
  }
  const detachSignals = options.detachSignals ?? DEFAULT_DETACH_SIGNALS;
  const heartbeatScheduler = options.heartbeatScheduler ?? {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } satisfies VercelTerminalHeartbeatScheduler;
  if (Buffer.byteLength(startFrame) > MAX_CONTROL_FRAME_BYTES) {
    const failure = reportFailure(new Error('Terminal start frame exceeds control frame limit'), [interactive.token]);
    removeEarlyMessageListener();
    closeSocket(socket);
    return failureResult(failure);
  }

  return await new Promise<VercelTerminalResult>((resolve) => {
    let settled = false;
    let cleaned = false;
    let stopHeartbeat = () => {};
    let outputDrainTimer: ReturnType<typeof setTimeout> | undefined;
    let inputSendTimer: ReturnType<typeof setTimeout> | undefined;
    let socketFlowPaused = false;
    let inputFlowPaused = false;
    let lastFailure: VercelTerminalFailure | undefined;
    const reportError = (error: unknown): VercelTerminalFailure => {
      lastFailure = reportFailure(error, [interactive.token]);
      return lastFailure;
    };
    const stdinIsTTY = options.tty ?? Boolean(streams.stdin.isTTY);
    const wasRaw = streams.stdin.isRaw;
    const wasFlowing = streams.stdin.readableFlowing;
    const wasPaused = streams.stdin.isPaused();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      stopHeartbeat();
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onSocketError);
      socket.removeListener('close', onClose);
      streams.stdout.removeListener('error', onStdoutError);
      streams.stdout.removeListener('drain', onDrain);
      streams.stdin.removeListener('data', onStdin);
      streams.stdin.removeListener('end', onEof);
      streams.stdin.removeListener('close', onInputClose);
      streams.stdin.removeListener('error', onStdinError);
      signalSource.removeListener('SIGINT', onSigint);
      signalSource.removeListener('SIGWINCH', onResize);
      for (const signal of detachSignals) {
        signalSource.removeListener(signal, onTermination);
      }
      options.signal?.removeEventListener('abort', onAbort);
      if (outputDrainTimer !== undefined) clearTimeout(outputDrainTimer);
      outputDrainTimer = undefined;
      if (inputSendTimer !== undefined) clearTimeout(inputSendTimer);
      inputSendTimer = undefined;
      outputQueue.clear();
      blockedOutputBytes = 0;
      sendQueue.clear();
      if (socketFlowPaused) {
        resumeSocket(socket);
        socketFlowPaused = false;
      }
      inputFlowPaused = false;
      if (stdinIsTTY && streams.stdin.setRawMode && wasRaw !== undefined) {
        try {
          streams.stdin.setRawMode(wasRaw);
        } catch {
          // Ignore errors restoring raw mode.
        }
      }
      restoreReadableState(streams.stdin, wasFlowing, wasPaused);
      closeSocket(socket);
    };
    const finish = (result: VercelTerminalResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.onError !== undefined && result.status === 'detached' && result.reason === 'error' && !result.error && lastFailure) {
        resolve({ ...result, error: lastFailure });
      } else {
        resolve(result);
      }
    };
    const outputQueue = new BoundedBufferQueue(maxPendingOutputBytes);
    let blockedOutputBytes = 0;
    let outputBackpressured = false;
    let pendingExitCode: number | undefined;
    let pendingTerminalResult: Extract<VercelTerminalResult, { status: 'detached' }> | undefined;
    const hasPendingOutput = () => outputQueue.byteLength > 0 || blockedOutputBytes > 0 || outputBackpressured;
    const requestTerminal = (result: VercelTerminalResult) => {
      stopHeartbeat();
      if (result.status === 'exited') {
        pendingExitCode = result.code;
      } else if (!pendingTerminalResult) {
        pendingTerminalResult = result;
      }
      maybeFinishPendingResult();
    };
    const maybeFinishPendingResult = () => {
      if (settled || hasPendingOutput()) return;
      if (pendingExitCode !== undefined) {
        const code = pendingExitCode;
        pendingExitCode = undefined;
        pendingTerminalResult = undefined;
        finish({ status: 'exited', code });
      } else if (pendingTerminalResult) {
        const result = pendingTerminalResult;
        pendingTerminalResult = undefined;
        finish(result);
      }
    };
    const armOutputDrainTimeout = () => {
      if (outputDrainTimer !== undefined) return;
      outputDrainTimer = setTimeout(() => {
        outputDrainTimer = undefined;
        if (settled || !outputBackpressured) return;
        reportError(new Error('Terminal stdout drain timed out'));
        if (pendingExitCode !== undefined) {
          const code = pendingExitCode;
          pendingExitCode = undefined;
          pendingTerminalResult = undefined;
          finish({ status: 'exited', code });
          return;
        }
        finish(pendingTerminalResult ?? { status: 'detached', reason: 'error' });
      }, backpressureTimeoutMs);
    };
    const writeOutput = (chunk: Buffer): boolean => {
      try {
        if (streams.stdout.write(chunk)) return true;
        blockedOutputBytes = chunk.length;
        outputBackpressured = true;
        pauseSocket(socket);
        socketFlowPaused = true;
        streams.stdout.once('drain', onDrain);
        armOutputDrainTimeout();
        return false;
      } catch (error) {
        onStdoutError(error);
        return false;
      }
    };
    const flushOutput = () => {
      if (settled || outputBackpressured) return;
      while (outputQueue.length > 0 && !settled) {
        const chunk = outputQueue.shift();
        if (!chunk || !writeOutput(chunk)) return;
      }
      maybeFinishPendingResult();
    };
    const enqueueOutput = (chunk: Buffer) => {
      if (chunk.length > MAX_BUFFER_LIMIT_BYTES) {
        reportError(new Error('Terminal output direct frame limit exceeded'));
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      if (chunk.length > maxPendingOutputBytes && !hasPendingOutput()) {
        writeOutput(chunk);
        return;
      }
      if (outputQueue.byteLength + blockedOutputBytes + chunk.length > maxPendingOutputBytes
        || !outputQueue.enqueue(chunk)) {
        reportError(new Error('Terminal output backpressure limit exceeded'));
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      flushOutput();
    };
    const onDrain = () => {
      outputBackpressured = false;
      blockedOutputBytes = 0;
      if (outputDrainTimer !== undefined) clearTimeout(outputDrainTimer);
      outputDrainTimer = undefined;
      if (socketFlowPaused) {
        resumeSocket(socket);
        socketFlowPaused = false;
      }
      flushOutput();
    };
    const onStdoutError = (error: unknown) => {
      reportError(error);
      finish({ status: 'detached', reason: 'error' });
    };
    const requestExit = (code: number) => {
      requestTerminal({ status: 'exited', code });
    };
    const onMessage = (data: unknown, isBinary: boolean) => {
      let buffer: Buffer;
      try {
        buffer = toBuffer(data);
      } catch (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      if (!isBinary) {
        if (buffer.length > MAX_CONTROL_FRAME_BYTES) {
          reportError(new Error('Terminal control frame limit exceeded'));
          requestTerminal({ status: 'detached', reason: 'error' });
          return;
        }
        try {
          const message = JSON.parse(buffer.toString('utf8')) as {
            type?: unknown;
            code?: unknown;
          };
          if (message.type === 'exit' && typeof message.code === 'number') {
            requestExit(message.code);
            return;
          }
        } catch {
          // Malformed text remains terminal output below.
        }
      }
      enqueueOutput(buffer);
    };
    const onSocketError = (error: unknown) => {
      reportError(error);
      requestTerminal({ status: 'detached', reason: 'error' });
    };
    const sendQueue = new BoundedBufferQueue(maxPendingInputBytes);
    let sendInFlight = false;
    let inFlightQueued = false;
    let pendingInputResult: VercelTerminalResult | undefined;
    const pauseInput = () => {
      if (inputFlowPaused || settled) return;
      try {
        streams.stdin.pause();
        inputFlowPaused = true;
      } catch (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
      }
    };
    const resumeInput = () => {
      if (!inputFlowPaused || settled) return;
      try {
        streams.stdin.resume();
        inputFlowPaused = false;
      } catch (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
      }
    };
    const completeInputSend = (error?: Error) => {
      if (settled) return;
      if (inFlightQueued) sendQueue.shift();
      inFlightQueued = false;
      sendInFlight = false;
      if (inputSendTimer !== undefined) clearTimeout(inputSendTimer);
      inputSendTimer = undefined;
      if (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      flushSendQueue();
      if (!sendInFlight && sendQueue.length === 0) {
        resumeInput();
        if (pendingInputResult) {
          const result = pendingInputResult;
          pendingInputResult = undefined;
          requestTerminal(result);
        }
      }
    };
    const beginInputSend = (chunk: Buffer, queued: boolean) => {
      sendInFlight = true;
      inFlightQueued = queued;
      pauseInput();
      if (settled) {
        sendInFlight = false;
        inFlightQueued = false;
        return;
      }
      inputSendTimer = setTimeout(() => {
        inputSendTimer = undefined;
        if (!settled && sendInFlight) {
          reportError(new Error('Terminal input send backpressure timed out'));
          requestTerminal({ status: 'detached', reason: 'error' });
        }
      }, backpressureTimeoutMs);
      try {
        socket.send(chunk, completeInputSend);
      } catch (error) {
        completeInputSend(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const flushSendQueue = () => {
      if (settled || sendInFlight || sendQueue.length === 0) return;
      const chunk = sendQueue.peek();
      if (!chunk) return;
      beginInputSend(chunk, true);
    };
    const sendInput = (chunk: Buffer) => {
      if (socket.readyState !== OPEN || settled || chunk.length === 0) return;
      if (chunk.length > MAX_BUFFER_LIMIT_BYTES) {
        reportError(new Error('Terminal input direct frame limit exceeded'));
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      if (chunk.length > maxPendingInputBytes && !sendInFlight && sendQueue.length === 0) {
        beginInputSend(chunk, false);
        return;
      }
      if (!sendQueue.enqueue(chunk)) {
        reportError(new Error('Terminal input backpressure limit exceeded'));
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      flushSendQueue();
    };
    const onStdin = (chunk: unknown) => {
      let input: Buffer;
      try {
        input = toBuffer(chunk);
      } catch (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      const escapeAt = input.indexOf(0x1d);
      if (escapeAt >= 0) {
        stopHeartbeat();
        if (escapeAt > 0) sendInput(input.subarray(0, escapeAt));
        const result = { status: 'detached', reason: 'escape' } as const;
        if (sendInFlight || sendQueue.length > 0) pendingInputResult = result;
        else requestTerminal(result);
        return;
      }
      sendInput(input);
    };
    const onSigint = () => sendInput(Buffer.from([0x03]));
    // The official protocol defines no SIGTERM/SIGHUP frame; configured signals detach.
    const onTermination = () => requestTerminal({ status: 'detached', reason: 'signal' });
    const onEof = () => requestTerminal({ status: 'detached', reason: 'eof' });
    const onInputClose = () => requestTerminal({ status: 'detached', reason: 'eof' });
    const onStdinError = (error: unknown) => {
      reportError(error);
      requestTerminal({ status: 'detached', reason: 'error' });
    };
    const sendControl = (frame: string) => {
      if (Buffer.byteLength(frame) > MAX_CONTROL_FRAME_BYTES) {
        reportError(new Error('Terminal control frame exceeds control frame limit'));
        requestTerminal({ status: 'detached', reason: 'error' });
        return;
      }
      try {
        socket.send(frame, (error) => {
          if (error) {
            reportError(error);
            requestTerminal({ status: 'detached', reason: 'error' });
          }
        });
      } catch (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
      }
    };
    const onResize = () => {
      if (socket.readyState !== OPEN || settled) return;
      try {
        const nextSize = getSize();
        validateSize(nextSize);
        sendControl(JSON.stringify({ type: 'resize', ...nextSize }));
      } catch (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
      }
    };
    const onClose = () => requestTerminal({ status: 'detached', reason: 'close' });
    const onAbort = () => requestTerminal({ status: 'detached', reason: 'abort' });
    socket.on('message', onMessage);
    socket.on('error', onSocketError);
    socket.on('close', onClose);
    // The connecting guard stays until all session transport listeners own the socket.
    removeEarlyMessageListener();
    removeSocketErrorGuard();
    streams.stdout.on('error', onStdoutError);
    if (stdinIsTTY && streams.stdin.setRawMode) {
      try {
        streams.stdin.setRawMode(true);
      } catch (error) {
        reportError(error);
        finish({ status: 'detached', reason: 'error' });
        return;
      }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    // Hold stdin until the start frame is accepted so bytes written while
    // openInteractive/WebSocket setup is still in flight cannot outrun shell spawn
    // after stop→resume, where that race shows up as a silent ready hang.
    const armStdin = () => {
      if (settled || cleaned) return;
      streams.stdin.on('data', onStdin);
      streams.stdin.on('end', onEof);
      streams.stdin.on('close', onInputClose);
      streams.stdin.on('error', onStdinError);
      signalSource.on('SIGINT', onSigint);
      signalSource.on('SIGWINCH', onResize);
      for (const signal of detachSignals) {
        signalSource.on(signal, onTermination);
      }
      try {
        streams.stdin.resume();
      } catch (error) {
        reportError(error);
        requestTerminal({ status: 'detached', reason: 'error' });
      }
    };
    try {
      socket.send(startFrame, (error) => {
        if (error) {
          reportError(error);
          finish({ status: 'detached', reason: 'error' });
          return;
        }
        armStdin();
      });
    } catch (error) {
      reportError(error);
      finish({ status: 'detached', reason: 'error' });
      return;
    }
    if (settled) return;
    stopHeartbeat = startTerminalHeartbeat({
      socket,
      intervalMs: heartbeatIntervalMs,
      scheduler: heartbeatScheduler,
      onError: (error) => {
        reportError(error);
        finish({ status: 'detached', reason: 'error' });
      },
    });
    if (settled) return;
    if (earlyMessageOverflow) {
      reportError(new Error('Terminal early message buffer limit exceeded'));
      finish({ status: 'detached', reason: 'error' });
      return;
    }
    for (const message of earlyMessages) {
      if (settled) break;
      onMessage(message.data, message.isBinary);
    }
  });
}

function startTerminalHeartbeat(input: {
  socket: VercelTerminalWebSocket;
  intervalMs: number;
  scheduler: VercelTerminalHeartbeatScheduler;
  onError: (error: unknown) => void;
}): () => void {
  let stopped = false;
  let timer: unknown;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) input.scheduler.clearTimeout(timer);
    timer = undefined;
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stop();
    input.onError(error);
  };
  const schedule = () => {
    if (stopped) return;
    try {
      timer = input.scheduler.setTimeout(() => {
        timer = undefined;
        if (stopped) return;
        try {
          input.socket.ping((error) => {
            if (error) fail(error);
          });
        } catch (error) {
          fail(error);
          return;
        }
        schedule();
      }, input.intervalMs);
    } catch (error) {
      fail(error);
    }
  };
  schedule();
  return stop;
}

function closeSocket(socket: VercelTerminalWebSocket | undefined): void {
  if (!socket) return;
  installCloseErrorGuard(socket);
  try {
    socket.close();
  } catch {
    // The socket may already be closed.
  }
}

function installCloseErrorGuard(socket: VercelTerminalWebSocket): () => void {
  let removed = false;
  let removalTimer: ReturnType<typeof setImmediate> | undefined;
  const remove = () => {
    if (removed) return;
    removed = true;
    if (removalTimer !== undefined) clearImmediate(removalTimer);
    socket.removeListener('error', ignoreSocketError);
    socket.removeListener('close', onClose);
  };
  const onClose = () => {
    if (removalTimer === undefined) removalTimer = setImmediate(remove);
  };
  socket.on('error', ignoreSocketError);
  if (socket.readyState === 3) onClose();
  else socket.once('close', onClose);
  return remove;
}

function ignoreSocketError(): void {
  // A WebSocket may report a late close error after the session is detached.
}

function validateSize(size: VercelTerminalSize): void {
  if (!Number.isInteger(size.cols) || size.cols <= 0 || !Number.isInteger(size.rows) || size.rows <= 0) {
    throw new Error('Terminal dimensions must be positive integers');
  }
}

function terminalDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function createTerminalFailure(
  error: unknown,
  secrets: readonly string[] = [],
): VercelTerminalFailure {
  const message = redactSecrets(error, secrets);
  const cause = new Error(message);
  if (error instanceof Error) cause.name = error.name;
  return { cause, message };
}

function writeError(
  stream: NodeJS.WritableStream,
  error: unknown,
  secrets: readonly string[] = [],
): void {
  const message = redactSecrets(error, secrets);
  try {
    stream.write(`${message}\n`);
  } catch {
    // Error reporting must not create an uncaught stream error.
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => toBuffer(part)));
  throw new Error('Unsupported WebSocket message data');
}

async function waitForOpen(
  socket: VercelTerminalWebSocket,
  signal: AbortSignal | undefined,
  options: {
    errorGuard: () => void;
    timeoutMs: number;
    scheduler: VercelTerminalScheduler;
  },
): Promise<() => void> {
  if (socket.readyState === OPEN) return options.errorGuard;
  if (socket.readyState === 3) {
    return Promise.reject(new Error('WebSocket is already closed'));
  }
  if (socket.readyState === 2) {
    return Promise.reject(new Error('WebSocket is already closing'));
  }
  if (signal?.aborted) {
    closeSocket(socket);
    return Promise.reject(signal.reason ?? new Error('Terminal connection aborted'));
  }
  return await new Promise<() => void>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    const cleanup = () => {
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) options.scheduler.clearTimeout(timer);
      timer = undefined;
    };
    const settleReject = (error: unknown, close: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (close) closeSocket(socket);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(options.errorGuard);
    };
    const onError = (error: unknown) => {
      settleReject(error instanceof Error ? error : new Error('WebSocket connection failed'), false);
    };
    const onClose = () => {
      settleReject(new Error('WebSocket connection closed before opening'), false);
    };
    const onAbort = () => {
      settleReject(signal?.reason ?? new Error('Terminal connection aborted'), true);
    };
    const onTimeout = () => {
      settleReject(new Error(`WebSocket connection timed out after ${options.timeoutMs}ms`), true);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = options.scheduler.setTimeout(onTimeout, options.timeoutMs);
  });
}
