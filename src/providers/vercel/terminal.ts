import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { redactSecrets } from './redaction.js';
import {
  startTimeoutExtension,
  type VercelTerminalTimeoutOptions,
} from './terminal-timeout.js';

export type { VercelTerminalTimeoutOptions, VercelTerminalTimeoutScheduler } from './terminal-timeout.js';

const OPEN = 1;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const TERM = 'xterm-256color';
const PS1 = `▲ \x01\x1b[2m\x02$PWD/\x01\x1b[0m\x02 `;

export interface VercelTerminalWebSocket extends EventEmitter {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: Buffer | string, callback?: (error?: Error) => void): void | boolean;
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
  extendTimeout?: (durationMs: number, options?: { signal?: AbortSignal }) => Promise<void>;
}

export type VercelTerminalResult =
  | { status: 'exited'; code: number }
  | { status: 'detached'; reason: 'close' | 'error' | 'abort' | 'escape' | 'eof' | 'signal' };

export interface VercelTerminalOptions {
  cwd?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  streams?: VercelTerminalStreams;
  signal?: AbortSignal;
  signalSource?: EventEmitter;
  detachSignals?: readonly ('SIGTERM' | 'SIGHUP')[];
  getSize?: () => VercelTerminalSize;
  timeoutExtension?: VercelTerminalTimeoutOptions | false;
}

export interface VercelTerminalAdapterDependencies {
  createWebSocket?: (url: string) => VercelTerminalWebSocket;
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
  const createWebSocket = dependencies.createWebSocket ?? ((url: string) =>
    new WebSocket(url) as unknown as VercelTerminalWebSocket);
  const defaultStreams = dependencies.streams ?? processStreams();
  const defaultSignalSource = dependencies.signalSource ?? process;

  return {
    attach: (sandbox, options = {}) => attachTerminal({
      sandbox,
      options,
      createWebSocket,
      streams: options.streams ?? defaultStreams,
      signalSource: options.signalSource ?? defaultSignalSource,
    }),
  };
}

async function attachTerminal(input: {
  sandbox: VercelInteractiveSandbox;
  options: VercelTerminalOptions;
  createWebSocket: (url: string) => VercelTerminalWebSocket;
  streams: VercelTerminalStreams;
  signalSource: EventEmitter;
}): Promise<VercelTerminalResult> {
  const { sandbox, options, createWebSocket, streams, signalSource } = input;
  let interactive: Awaited<ReturnType<VercelInteractiveSandbox['openInteractive']>>;
  try {
    interactive = await sandbox.openInteractive({ signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) return { status: 'detached', reason: 'abort' };
    writeError(streams.stderr, error);
    return { status: 'detached', reason: 'error' };
  }
  if (options.signal?.aborted) return { status: 'detached', reason: 'abort' };

  let socket: VercelTerminalWebSocket | undefined;
  try {
    const socketUrl = new URL(interactive.url);
    const tokenQuery = `token=${encodeURIComponent(interactive.token)}`;
    socketUrl.search = socketUrl.search
      ? `${socketUrl.search}&${tokenQuery}`
      : `?${tokenQuery}`;
    socket = createWebSocket(socketUrl.toString());
    await waitForOpen(socket, options.signal);
  } catch (error) {
    closeSocket(socket);
    if (options.signal?.aborted) return { status: 'detached', reason: 'abort' };
    writeError(streams.stderr, error, [interactive.token]);
    return { status: 'detached', reason: 'error' };
  }
  if (!socket) {
    writeError(streams.stderr, new Error('WebSocket client was not created'));
    return { status: 'detached', reason: 'error' };
  }

  const getSize = options.getSize ?? (() => ({
    cols: streams.stdout.columns ?? DEFAULT_COLUMNS,
    rows: streams.stdout.rows ?? DEFAULT_ROWS,
  }));
  let startFrame: string;
  try {
    const size = getSize();
    validateSize(size);
    const env = { TERM, PS1, ...(options.env ?? {}) };
    startFrame = JSON.stringify({
      type: 'start',
      command: 'shell',
      args: [...(options.args ?? [])],
      env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      cwd: options.cwd ?? sandbox.cwd ?? '/vercel/sandbox',
      cols: size.cols,
      rows: size.rows,
    });
  } catch (error) {
    writeError(streams.stderr, error, [interactive.token]);
    closeSocket(socket);
    return { status: 'detached', reason: 'error' };
  }

  return await new Promise<VercelTerminalResult>((resolve) => {
    let settled = false;
    let cleaned = false;
    let stopTimeoutExtension = () => {};
    const sessionController = new AbortController();
    const reportError = (error: unknown) => writeError(streams.stderr, error, [interactive.token]);
    const wasRaw = streams.stdin.isRaw ?? false;
    const wasPaused = streams.stdin.isPaused();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onSocketError);
      socket.removeListener('close', onClose);
      streams.stdout.removeListener('error', onStdoutError);
      streams.stdout.removeListener('drain', onDrain);
      socket.removeListener('drain', onSocketDrain);
      streams.stdin.removeListener('data', onStdin);
      streams.stdin.removeListener('end', onEof);
      streams.stdin.removeListener('close', onInputClose);
      signalSource.removeListener('SIGINT', onSigint);
      signalSource.removeListener('SIGWINCH', onResize);
      for (const signal of options.detachSignals ?? []) {
        signalSource.removeListener(signal, onTermination);
      }
      options.signal?.removeEventListener('abort', onAbort);
      stopTimeoutExtension();
      sessionController.abort();
      if (streams.stdin.isTTY && streams.stdin.setRawMode) {
        try {
          streams.stdin.setRawMode(wasRaw);
        } catch {
          // Ignore errors restoring raw mode.
        }
      }
      try {
        if (wasPaused) streams.stdin.pause();
        else streams.stdin.resume();
      } catch {
        // Ignore errors restoring stream flow.
      }
      closeSocket(socket);
    };
    const finish = (result: VercelTerminalResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const outputQueue: Buffer[] = [];
    let outputBackpressured = false;
    let pendingExitCode: number | undefined;
    const flushOutput = () => {
      if (settled || outputBackpressured) return;
      while (outputQueue.length > 0 && !settled) {
        const chunk = outputQueue.shift();
        if (!chunk) continue;
        try {
          if (!streams.stdout.write(chunk)) {
            outputBackpressured = true;
            streams.stdout.once('drain', onDrain);
            return;
          }
        } catch (error) {
          onStdoutError(error);
          return;
        }
      }
      if (pendingExitCode !== undefined && outputQueue.length === 0 && !outputBackpressured) {
        const code = pendingExitCode;
        pendingExitCode = undefined;
        finish({ status: 'exited', code });
      }
    };
    const enqueueOutput = (chunk: Buffer) => {
      outputQueue.push(chunk);
      flushOutput();
    };
    const onDrain = () => {
      outputBackpressured = false;
      flushOutput();
    };
    const onStdoutError = (error: unknown) => {
      reportError(error);
      finish({ status: 'detached', reason: 'error' });
    };
    const requestExit = (code: number) => {
      if (outputQueue.length === 0 && !outputBackpressured) {
        finish({ status: 'exited', code });
      } else {
        pendingExitCode = code;
      }
    };
    const onMessage = (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        enqueueOutput(toBuffer(data));
        return;
      }
      try {
        const message = JSON.parse(toBuffer(data).toString('utf8')) as {
          type?: unknown;
          code?: unknown;
        };
        if (message.type === 'exit' && typeof message.code === 'number') {
          requestExit(message.code);
          return;
        }
        enqueueOutput(toBuffer(data));
      } catch {
        enqueueOutput(toBuffer(data));
      }
    };
    const onSocketError = (error: unknown) => {
      reportError(error);
      finish({ status: 'detached', reason: 'error' });
    };
    const sendQueue: Buffer[] = [];
    let sendInFlight = false;
    let waitingForSocketDrain = false;
    const flushSendQueue = () => {
      if (settled || sendInFlight || waitingForSocketDrain || sendQueue.length === 0) return;
      const chunk = sendQueue.shift();
      if (!chunk) return;
      sendInFlight = true;
      const callbackSupported = socket.send.length >= 2;
      try {
        if (callbackSupported) {
          socket.send(chunk, (error) => {
            if (error) {
              reportError(error);
              finish({ status: 'detached', reason: 'error' });
              return;
            }
            sendInFlight = false;
            flushSendQueue();
          });
          return;
        }
        const accepted = socket.send(chunk);
        if (accepted === false) {
          waitingForSocketDrain = true;
          socket.once('drain', onSocketDrain);
          return;
        }
        sendInFlight = false;
        flushSendQueue();
      } catch (error) {
        reportError(error);
        finish({ status: 'detached', reason: 'error' });
      }
    };
    const onSocketDrain = () => {
      waitingForSocketDrain = false;
      sendInFlight = false;
      flushSendQueue();
    };
    const sendInput = (chunk: Buffer) => {
      if (socket.readyState !== OPEN || settled) return;
      sendQueue.push(chunk);
      flushSendQueue();
    };
    const onStdin = (chunk: unknown) => {
      const input = toBuffer(chunk);
      const escapeAt = input.indexOf(0x1d);
      if (escapeAt >= 0) {
        if (escapeAt > 0) sendInput(input.subarray(0, escapeAt));
        finish({ status: 'detached', reason: 'escape' });
        return;
      }
      sendInput(input);
    };
    const onSigint = () => sendInput(Buffer.from([0x03]));
    // The official protocol defines no SIGTERM/SIGHUP frame; configured signals detach.
    const onTermination = () => finish({ status: 'detached', reason: 'signal' });
    const onEof = () => finish({ status: 'detached', reason: 'eof' });
    const onInputClose = () => finish({ status: 'detached', reason: 'eof' });
    const onResize = () => {
      if (socket.readyState !== OPEN || settled) return;
      try {
        const nextSize = getSize();
        validateSize(nextSize);
        socket.send(JSON.stringify({ type: 'resize', ...nextSize }));
      } catch (error) {
        reportError(error);
        finish({ status: 'detached', reason: 'error' });
      }
    };
    const onClose = () => finish({ status: 'detached', reason: 'close' });
    const onAbort = () => finish({ status: 'detached', reason: 'abort' });
    socket.on('message', onMessage);
    socket.on('error', onSocketError);
    socket.on('close', onClose);
    streams.stdout.on('error', onStdoutError);
    streams.stdin.on('data', onStdin);
    streams.stdin.on('end', onEof);
    streams.stdin.on('close', onInputClose);
    signalSource.on('SIGINT', onSigint);
    signalSource.on('SIGWINCH', onResize);
    for (const signal of options.detachSignals ?? []) {
      signalSource.on(signal, onTermination);
    }
    if (streams.stdin.isTTY && streams.stdin.setRawMode) {
      try {
        streams.stdin.setRawMode(true);
      } catch (error) {
        reportError(error);
        finish({ status: 'detached', reason: 'error' });
        return;
      }
    }
    if (wasPaused) streams.stdin.resume();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    try {
      socket.send(startFrame, (error) => {
        if (error) {
          reportError(error);
          finish({ status: 'detached', reason: 'error' });
        }
      });
    } catch (error) {
      reportError(error);
      finish({ status: 'detached', reason: 'error' });
      return;
    }
    if (settled) return;
    if (options.timeoutExtension !== false) {
      try {
        stopTimeoutExtension = startTimeoutExtension(
          sandbox,
          options.timeoutExtension ?? {},
          sessionController.signal,
          (error) => {
            reportError(error);
            finish({ status: 'detached', reason: 'error' });
          },
        );
      } catch (error) {
        reportError(error);
        finish({ status: 'detached', reason: 'error' });
      }
    }
  });
}

function closeSocket(socket: VercelTerminalWebSocket | undefined): void {
  if (!socket) return;
  try {
    socket.on('error', ignoreSocketError);
    socket.close();
  } catch {
    // The socket may already be closed.
  }
}

function ignoreSocketError(): void {
  // A WebSocket may report a late close error after the session is detached.
}

function processStreams(): VercelTerminalStreams {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function validateSize(size: VercelTerminalSize): void {
  if (!Number.isInteger(size.cols) || size.cols <= 0 || !Number.isInteger(size.rows) || size.rows <= 0) {
    throw new Error('Terminal dimensions must be positive integers');
  }
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

async function waitForOpen(socket: VercelTerminalWebSocket, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error('WebSocket connection failed'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket connection closed before opening'));
    };
    const onAbort = () => {
      cleanup();
      try {
        socket.close();
      } catch {
        // The socket may already be closed.
      }
      reject(signal?.reason ?? new Error('Terminal connection aborted'));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
