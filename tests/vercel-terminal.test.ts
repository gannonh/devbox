import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createVercelTerminalAdapter,
  type VercelTerminalStreams,
  type VercelTerminalWebSocket,
} from '../src/providers/vercel/terminal.js';

class FakeWebSocket extends EventEmitter implements VercelTerminalWebSocket {
  readonly sent: Array<Buffer | string> = [];
  readonly url: string;
  readyState = 0;
  bufferedAmount = 0;
  blockSends = false;
  closeCount = 0;
  deferErrorAfterClose = false;
  deferErrorAfterOpen = false;
  deferMessageAfterOpen?: Buffer;
  deferPings = false;
  pauseCount = 0;
  pingCount = 0;
  pingException?: Error;
  resumeCount = 0;
  private paused = false;
  private readonly pendingCallbacks: Array<(error?: Error) => void> = [];
  private readonly pendingPingCallbacks: Array<(error?: Error) => void> = [];

  constructor(url: string) {
    super();
    this.url = url;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  send(data: Buffer | string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    if (this.blockSends && callback) {
      this.pendingCallbacks.push(callback);
      return;
    }
    callback?.();
  }

  releaseSend(error?: Error): void {
    this.pendingCallbacks.shift()?.(error);
  }

  ping(callback?: (error?: Error) => void): void {
    this.pingCount += 1;
    if (this.pingException) throw this.pingException;
    if (this.deferPings && callback) {
      this.pendingPingCallbacks.push(callback);
      return;
    }
    callback?.();
  }

  releasePing(error?: Error): void {
    this.pendingPingCallbacks.shift()?.(error);
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }

  resume(): void {
    this.resumeCount += 1;
    this.paused = false;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
    if (this.deferErrorAfterOpen || this.deferMessageAfterOpen) {
      process.nextTick(() => {
        if (this.deferMessageAfterOpen) this.emit('message', this.deferMessageAfterOpen, true);
        if (this.deferErrorAfterOpen) this.emit('error', new Error('early post-open error'));
      });
    }
  }

  emitMessage(data: Buffer | string, isBinary: boolean): void {
    this.emit('message', data, isBinary);
  }

  close(): void {
    this.closeCount += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
    if (this.deferErrorAfterClose) {
      queueMicrotask(() => this.emit('error', new Error('late connecting close error')));
    }
  }

  setClosing(): void {
    this.readyState = 2;
  }
}

function streams(isTTY = false): VercelTerminalStreams & { input: PassThrough; output: PassThrough; error: PassThrough } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => void; _readableState?: { flowing: boolean | null } };
  input.isTTY = isTTY;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
  };
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
  output.columns = 120;
  output.rows = 40;
  const error = new PassThrough();
  return {
    stdin: input,
    stdout: output,
    stderr: error,
    input,
    output,
    error,
  };
}

function setFlowing(input: PassThrough, flowing: boolean | null): void {
  const state = (input as PassThrough & { _readableState?: { flowing: boolean | null } })._readableState;
  if (!state) throw new Error('missing readable state');
  state.flowing = flowing;
}

interface ManualHeartbeatTimer {
  callback: () => void;
  delay: number;
  cancelled: boolean;
  fired: boolean;
}

function manualHeartbeatScheduler(): {
  timers: ManualHeartbeatTimer[];
  scheduler: {
    setTimeout(callback: () => void, delay: number): ManualHeartbeatTimer;
    clearTimeout(handle: unknown): void;
  };
} {
  const timers: ManualHeartbeatTimer[] = [];
  return {
    timers,
    scheduler: {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, cancelled: false, fired: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        const timer = timers.find((candidate) => candidate === handle);
        if (timer) timer.cancelled = true;
      },
    },
  };
}

function fireHeartbeat(timer: ManualHeartbeatTimer): void {
  timer.fired = true;
  timer.callback();
}

function activeHeartbeats(timers: readonly ManualHeartbeatTimer[]): ManualHeartbeatTimer[] {
  return timers.filter((timer) => !timer.cancelled && !timer.fired);
}

type HeartbeatCleanupPath =
  | 'escape'
  | 'eof'
  | 'abort'
  | 'socket-error'
  | 'socket-close'
  | 'remote-completion'
  | 'startup-failure';

const heartbeatCleanupPaths: readonly HeartbeatCleanupPath[] = [
  'escape',
  'eof',
  'abort',
  'socket-error',
  'socket-close',
  'remote-completion',
  'startup-failure',
];

describe('Vercel terminal adapter', () => {
  it('opens an interactive endpoint and sends the official shell start frame', async () => {
    const token = 'token with spaces&symbols';
    const sockets: FakeWebSocket[] = [];
    let webSocketOptions: { maxPayload: number } | undefined;
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url, options) => {
        webSocketOptions = options;
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const sandbox = {
      cwd: '/vercel/sandbox/cloned-repository',
      openInteractive: async () => ({
        url: 'wss://interactive.example/session?existing=1',
        token,
      }),
    };

    const resultPromise = terminal.attach(sandbox, {
      cwd: sandbox.cwd,
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 120, rows: 40 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    expect(sockets).toHaveLength(1);
    expect(webSocketOptions).toEqual({ maxPayload: 16 * 1024 * 1024 });
    expect(sockets[0].url).toBe(
      `wss://interactive.example/session?existing=1&token=${encodeURIComponent(token)}`,
    );
    expect(sockets[0].sent).toHaveLength(1);
    expect(JSON.parse(String(sockets[0].sent[0]))).toEqual({
      type: 'start',
      command: 'sh',
      args: [],
      env: ['TERM=xterm-256color', expect.stringMatching(/^PS1=/)],
      cwd: '/vercel/sandbox/cloned-repository',
      cols: 120,
      rows: 40,
    });

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('sends periodic protocol pings and stops before pending output drains', async () => {
    const sockets: FakeWebSocket[] = [];
    const { scheduler, timers } = manualHeartbeatScheduler();
    const onError = vi.fn(() => true);
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        socket.deferPings = true;
        sockets.push(socket);
        return socket;
      },
    });
    const terminalStreams = streams();
    const originalWrite = terminalStreams.stdout.write.bind(terminalStreams.stdout);
    terminalStreams.stdout.write = ((chunk: string | Uint8Array) => {
      originalWrite(chunk);
      return false;
    }) as typeof terminalStreams.stdout.write;
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      heartbeatIntervalMs: 25_000,
      heartbeatScheduler: scheduler,
      getSize: () => ({ cols: 80, rows: 24 }),
      onError,
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(timers).toHaveLength(0);

    sockets[0].open();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0].delay).toBe(25_000);
    fireHeartbeat(timers[0]);
    expect(sockets[0].pingCount).toBe(1);
    expect(timers).toHaveLength(2);

    sockets[0].emitMessage(Buffer.from('pending output'), true);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    expect(timers[1].cancelled).toBe(true);
    fireHeartbeat(timers[1]);
    sockets[0].releasePing(new Error('late heartbeat failure'));
    expect(sockets[0].pingCount).toBe(1);
    expect(onError).not.toHaveBeenCalled();

    terminalStreams.stdout.emit('drain');
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
    expect(activeHeartbeats(timers)).toHaveLength(0);
    expect(sockets[0].closeCount).toBe(1);
  });

  it.each(['synchronous', 'asynchronous'] as const)(
    'routes a %s protocol ping failure through the redacted terminal error path',
    async (failureKind) => {
      const token = `heartbeat-${failureKind}-secret`;
      const failure = new Error(`${failureKind} heartbeat failure ${token}`);
      const sockets: FakeWebSocket[] = [];
      const failures: Array<{ cause: Error; message: string }> = [];
      const { scheduler, timers } = manualHeartbeatScheduler();
      const terminal = createVercelTerminalAdapter({
        createWebSocket: (url) => {
          const socket = new FakeWebSocket(url);
          socket.deferPings = failureKind === 'asynchronous';
          if (failureKind === 'synchronous') socket.pingException = failure;
          sockets.push(socket);
          queueMicrotask(() => socket.open());
          return socket;
        },
      });
      const resultPromise = terminal.attach({
        openInteractive: async () => ({ url: 'wss://interactive.example/session', token }),
      }, {
        streams: streams(),
        signalSource: new EventEmitter(),
        heartbeatIntervalMs: 25_000,
        heartbeatScheduler: scheduler,
        getSize: () => ({ cols: 80, rows: 24 }),
        onError: (terminalFailure) => {
          failures.push(terminalFailure);
          return true;
        },
      });
      await vi.waitFor(() => expect(timers).toHaveLength(1));

      fireHeartbeat(timers[0]);
      if (failureKind === 'asynchronous') sockets[0].releasePing(failure);

      const result = await resultPromise;
      expect(result).toMatchObject({
        status: 'detached',
        reason: 'error',
        error: { message: expect.stringContaining('[REDACTED]') },
      });
      expect(failures).toHaveLength(1);
      expect(failures[0].cause.message).toContain('[REDACTED]');
      expect(failures[0].cause.message).not.toContain(token);
      expect(JSON.stringify({ result, failures })).not.toContain(token);
      expect(activeHeartbeats(timers)).toHaveLength(0);
      expect(sockets[0].closeCount).toBe(1);
      for (const timer of timers) timer.callback();
      sockets[0].releasePing(new Error('late heartbeat failure'));
      expect(sockets[0].pingCount).toBe(1);
      expect(failures).toHaveLength(1);
    },
  );

  it.each(heartbeatCleanupPaths)('cancels heartbeat work on %s', async (path) => {
    const sockets: FakeWebSocket[] = [];
    const { scheduler, timers } = manualHeartbeatScheduler();
    const terminalStreams = streams();
    const controller = new AbortController();
    const onError = vi.fn(() => true);
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        socket.deferPings = true;
        socket.blockSends = path === 'startup-failure';
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signal: controller.signal,
      signalSource: new EventEmitter(),
      heartbeatIntervalMs: 25_000,
      heartbeatScheduler: scheduler,
      getSize: () => ({ cols: 80, rows: 24 }),
      onError,
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));

    const socket = sockets[0];
    fireHeartbeat(timers[0]);
    expect(timers).toHaveLength(2);
    switch (path) {
      case 'escape': terminalStreams.input.emit('data', Buffer.from([0x1d])); break;
      case 'eof': terminalStreams.input.emit('end'); break;
      case 'abort': controller.abort(); break;
      case 'socket-error': socket.emit('error', new Error('socket failed')); break;
      case 'socket-close': socket.close(); break;
      case 'remote-completion': socket.emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false); break;
      case 'startup-failure': socket.releaseSend(new Error('start frame failed')); break;
      default: {
        const exhaustive: never = path;
        throw new Error(`Unhandled heartbeat cleanup path: ${exhaustive}`);
      }
    }

    const result = await resultPromise;
    expect(result.status).toBe(path === 'remote-completion' ? 'exited' : 'detached');
    expect(timers[1].cancelled).toBe(true);
    const failureCount = onError.mock.calls.length;
    timers[1].callback();
    socket.releasePing(new Error('late heartbeat failure'));
    expect(socket.pingCount).toBe(1);
    expect(onError).toHaveBeenCalledTimes(failureCount);
    expect(activeHeartbeats(timers)).toHaveLength(0);
  });

  it('detaches cleanly when the WebSocket closes before opening', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.close());
        return socket;
      },
    });
    const terminalStreams = streams(true);

    const result = await terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });

    expect(result).toEqual({ status: 'detached', reason: 'error' });
    expect(sockets[0].readyState).toBe(3);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('returns a redacted structured failure and suppresses duplicate stderr when handled', async () => {
    const token = 'terminal-structured-secret';
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const failures: unknown[] = [];
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
      onError: (failure) => {
        failures.push(failure);
        return true;
      },
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0].emit('error', new Error(`transport failed ${token}`));

    const result = await resultPromise;
    expect(result).toMatchObject({ status: 'detached', reason: 'error', error: { message: expect.any(String) } });
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(failures)).not.toContain(token);
    expect(Buffer.concat(terminalStreams.error ? [terminalStreams.error.read() ?? Buffer.alloc(0)] : []).toString()).toBe('');
  });

  it('aborts cleanly when cancellation happens before the WebSocket opens', async () => {
    const sockets: FakeWebSocket[] = [];
    const controller = new AbortController();
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signal: controller.signal,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'abort' });
    expect(sockets[0].readyState).toBe(3);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('guards a deferred WebSocket error after abort closes a connecting socket', async () => {
    const sockets: FakeWebSocket[] = [];
    const controller = new AbortController();
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        socket.deferErrorAfterClose = true;
        sockets.push(socket);
        return socket;
      },
    });
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'connecting-token' }),
    }, {
      streams: streams(true),
      signal: controller.signal,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'abort' });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('hands off post-open nextTick messages and errors without an uncaught event', async () => {
    const sockets: FakeWebSocket[] = [];
    const output: Buffer[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        socket.deferMessageAfterOpen = Buffer.from('early output');
        socket.deferErrorAfterOpen = true;
        sockets.push(socket);
        setImmediate(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    terminalStreams.output.on('data', (chunk) => output.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    await vi.waitFor(() => expect(Buffer.concat(output)).toEqual(Buffer.from('early output')));

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('times out a connecting socket with a redacted actionable error', async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const scheduler = {
      setTimeout: (callback: () => void, delay: number) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout: () => {},
    };
    const token = 'connection-timeout-token';
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        socket.deferErrorAfterClose = true;
        sockets.push(socket);
        return socket;
      },
    });
    const terminalStreams = streams(true);
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      connectionTimeoutScheduler: scheduler,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(timers[0].delay).toBe(30_000);

    timers[0].callback();

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(sockets[0].readyState).toBe(3);
    expect(Buffer.concat(errors).toString()).toMatch(/connection timed out/);
    expect(Buffer.concat(errors).toString()).not.toContain(token);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('handles sockets already closed or closing before waitForOpen', async () => {
    for (const state of ['closed', 'closing'] as const) {
      const sockets: FakeWebSocket[] = [];
      const terminal = createVercelTerminalAdapter({
        createWebSocket: (url) => {
          const socket = new FakeWebSocket(url);
          if (state === 'closed') socket.close();
          else socket.setClosing();
          sockets.push(socket);
          return socket;
        },
      });

      await expect(terminal.attach({
        openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
      }, {
        streams: streams(),
        signalSource: new EventEmitter(),
        getSize: () => ({ cols: 80, rows: 24 }),
      })).resolves.toEqual({ status: 'detached', reason: 'error' });
      expect(sockets[0].readyState).toBe(3);
    }
  });

  it('validates and caps the connection timeout scheduler delay', async () => {
    const invalidFactory = vi.fn(() => new FakeWebSocket('wss://invalid.example'));
    const invalidTerminal = createVercelTerminalAdapter({ createWebSocket: invalidFactory });
    await expect(invalidTerminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: streams(),
      signalSource: new EventEmitter(),
      connectionTimeoutMs: 0,
    })).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(invalidFactory).not.toHaveBeenCalled();

    const timers: Array<{ callback: () => void; delay: number }> = [];
    const scheduler = {
      setTimeout: (callback: () => void, delay: number) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout: () => {},
    };
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const controller = new AbortController();
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: streams(),
      signal: controller.signal,
      signalSource: new EventEmitter(),
      connectionTimeoutMs: 3_000_000_000,
      connectionTimeoutScheduler: scheduler,
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0].delay).toBe(2_147_000_000);
    controller.abort();
    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'abort' });
  });

  it.each([null, false, true] as const)('restores neutral/paused/flowing stdin state after exit (%s)', async (flowing) => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    setFlowing(terminalStreams.input, flowing);
    const existingEnd = () => {};
    terminalStreams.input.on('end', existingEnd);
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);

    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
    expect(terminalStreams.input.readableFlowing).toBe(flowing);
    expect(terminalStreams.input.listeners('end')).toContain(existingEnd);
  });

  it.each([null, false, true] as const)('restores neutral/paused/flowing stdin state after transport error (%s)', async (flowing) => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    setFlowing(terminalStreams.input, flowing);
    const existingClose = () => {};
    terminalStreams.input.on('close', existingClose);
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emit('error', new Error('transport failed'));

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(terminalStreams.input.readableFlowing).toBe(flowing);
    expect(terminalStreams.input.listeners('close')).toContain(existingClose);
  });

  it('handles exit control text before the pending output byte limit', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: streams(),
      signalSource: new EventEmitter(),
      maxPendingOutputBytes: 16,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    const exitFrame = JSON.stringify({ type: 'exit', code: 23 });
    expect(Buffer.byteLength(exitFrame)).toBeGreaterThan(16);
    sockets[0].emitMessage(exitFrame, false);

    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 23 });
  });

  it('writes one oversized binary PTY frame directly when output is not pending', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const output: Buffer[] = [];
    terminalStreams.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(Buffer.from(chunk));
      return true;
    }) as typeof terminalStreams.stdout.write;
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    const largeOutput = Buffer.alloc(100 * 1024, 65);
    sockets[0].emitMessage(largeOutput, true);

    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(largeOutput);
    expect(sockets[0].pauseCount).toBe(0);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('pipes binary PTY output to stdout and binary stdin to the WebSocket', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const output: Buffer[] = [];
    terminalStreams.output.on('data', (chunk) => output.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    const remoteOutput = Buffer.from([0, 1, 255]);
    const localInput = Buffer.from([65, 3, 10]);
    sockets[0].emitMessage(remoteOutput, true);
    terminalStreams.input.emit('data', localInput);

    expect(Buffer.concat(output)).toEqual(remoteOutput);
    expect(sockets[0].sent[1]).toEqual(localInput);

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 7 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 7 });
  });

  it('sends one oversized stdin chunk directly under a small queue limit', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      maxPendingInputBytes: 16,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0].blockSends = true;
    const largeInput = Buffer.alloc(100 * 1024, 65);

    terminalStreams.input.emit('data', largeInput);

    expect(sockets[0].sent).toHaveLength(2);
    expect(sockets[0].sent[1]).toEqual(largeInput);
    expect(terminalStreams.input.isPaused()).toBe(true);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);

    sockets[0].releaseSend();
    expect(terminalStreams.input.isPaused()).toBe(false);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('bounds additional stdin chunks after a direct oversized send', async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const token = 'input-limit-token';
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      maxPendingInputBytes: 16,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0].blockSends = true;
    terminalStreams.input.emit('data', Buffer.alloc(100 * 1024, 65));
    terminalStreams.input.emit('data', Buffer.alloc(8, 66));
    terminalStreams.input.emit('data', Buffer.alloc(9, 67));

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(sockets[0].sent).toHaveLength(2);
    expect(Buffer.concat(errors).toString()).toMatch(/input backpressure limit/);
    expect(Buffer.concat(errors).toString()).not.toContain(token);
  });

  it('rejects input and output frames above the absolute direct-frame cap', async () => {
    const inputSockets: FakeWebSocket[] = [];
    const inputErrors: Buffer[] = [];
    const inputToken = 'oversized-input-token';
    const inputTerminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        inputSockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const inputStreams = streams();
    inputStreams.error.on('data', (chunk) => inputErrors.push(Buffer.from(chunk)));
    const inputResult = inputTerminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: inputToken }),
    }, {
      streams: inputStreams,
      signalSource: new EventEmitter(),
      maxPendingInputBytes: 16,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(inputSockets[0]?.sent).toHaveLength(1));
    inputStreams.input.emit('data', Buffer.alloc(16 * 1024 * 1024 + 1, 65));

    await expect(inputResult).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(inputSockets[0].sent).toHaveLength(1);
    expect(Buffer.concat(inputErrors).toString()).toMatch(/input direct frame limit/);
    expect(Buffer.concat(inputErrors).toString()).not.toContain(inputToken);

    const outputSockets: FakeWebSocket[] = [];
    const outputErrors: Buffer[] = [];
    const outputToken = 'oversized-output-token';
    const outputTerminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        outputSockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const outputStreams = streams();
    outputStreams.error.on('data', (chunk) => outputErrors.push(Buffer.from(chunk)));
    const outputResult = outputTerminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: outputToken }),
    }, {
      streams: outputStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(outputSockets[0]?.sent).toHaveLength(1));
    outputSockets[0].emitMessage(Buffer.alloc(16 * 1024 * 1024 + 1, 65), true);

    await expect(outputResult).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(Buffer.concat(outputErrors).toString()).toMatch(/output direct frame limit/);
    expect(Buffer.concat(outputErrors).toString()).not.toContain(outputToken);
  });

  it('forwards Ctrl-C, consumes Ctrl-], and restores raw mode on detach', async () => {
    const sockets: FakeWebSocket[] = [];
    const signalSource = new EventEmitter();
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    expect(terminalStreams.input.isRaw).toBe(true);

    signalSource.emit('SIGINT');
    terminalStreams.input.emit('data', Buffer.from([65, 3, 66]));
    terminalStreams.input.emit('data', Buffer.from([67, 0x1d, 68]));

    expect(sockets[0].sent.slice(1)).toEqual([
      Buffer.from([3]),
      Buffer.from([65, 3, 66]),
      Buffer.from([67]),
    ]);
    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'escape' });
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('sends validated resize frames and removes the resize listener on teardown', async () => {
    const sockets: FakeWebSocket[] = [];
    const signalSource = new EventEmitter();
    let size = { cols: 80, rows: 24 };
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource,
      getSize: () => size,
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    size = { cols: 132, rows: 43 };
    signalSource.emit('SIGWINCH');
    expect(JSON.parse(String(sockets[0].sent[1]))).toEqual({
      type: 'resize',
      cols: 132,
      rows: 43,
    });

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
    size = { cols: 160, rows: 50 };
    signalSource.emit('SIGWINCH');
    expect(sockets[0].sent).toHaveLength(2);
  });

  it('detaches on local EOF and restores the prior paused and raw state', async () => {
    const sockets: FakeWebSocket[] = [];
    const signalSource = new EventEmitter();
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    terminalStreams.input.pause();
    terminalStreams.input.isRaw = true;
    const existingListener = () => {};
    terminalStreams.input.on('data', existingListener);
    terminalStreams.input.pause();
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    terminalStreams.input.emit('end');

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'eof' });
    expect(terminalStreams.input.isRaw).toBe(true);
    expect(terminalStreams.input.isPaused()).toBe(true);
    expect(terminalStreams.input.listenerCount('data')).toBe(1);
    terminalStreams.input.removeListener('data', existingListener);
  });

  it('detaches on AbortSignal without stopping the sandbox', async () => {
    const sockets: FakeWebSocket[] = [];
    const controller = new AbortController();
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const openInteractive = async () => ({ url: 'wss://interactive.example/session', token: 'secret' });
    const resultPromise = terminal.attach({ cwd: '/vercel/sandbox/repository', openInteractive }, {
      streams: terminalStreams,
      signal: controller.signal,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    controller.abort();

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'abort' });
    expect(terminalStreams.input.isRaw).toBe(false);
    expect(sockets[0].readyState).toBe(3);
  });

  it('keeps malformed control text as output and reports network errors on stderr', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    terminalStreams.output.on('data', (chunk) => output.push(Buffer.from(chunk)));
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emitMessage('not-json', false);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 'bad' }), false);
    expect(Buffer.concat(output).toString()).toBe('not-json{"type":"exit","code":"bad"}');

    sockets[0].emit('error', new Error('connection failed'));

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(Buffer.concat(errors).toString()).toMatch(/connection failed/);
  });

  it('uses the control-frame guard for oversized text messages', async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emitMessage('x'.repeat(64 * 1024 + 1), false);

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(Buffer.concat(errors).toString()).toMatch(/control frame limit/);
  });

  it('routes stdin errors through redacted cleanup without an uncaught EventEmitter error', async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const token = 'stdin-token';
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const existingError = () => {};
    terminalStreams.input.on('error', existingError);
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    expect(() => terminalStreams.input.emit('error', new Error(`stdin failed: ${token}`))).not.toThrow();
    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(Buffer.concat(errors).toString()).not.toContain(token);
    expect(terminalStreams.input.listeners('error')).toContain(existingError);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('queues PTY output while stdout applies backpressure', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const writes: Buffer[] = [];
    let firstWrite = true;
    const originalWrite = terminalStreams.stdout.write.bind(terminalStreams.stdout);
    terminalStreams.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(Buffer.from(chunk));
      originalWrite(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    }) as typeof terminalStreams.stdout.write;
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emitMessage(Buffer.from('first'), true);
    sockets[0].emitMessage(Buffer.from('second'), true);
    expect(writes).toEqual([Buffer.from('first')]);
    expect(sockets[0].pauseCount).toBe(1);
    expect(sockets[0].isPaused).toBe(true);

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    sockets[0].close();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);
    terminalStreams.stdout.emit('drain');
    await vi.waitFor(() => expect(writes).toEqual([Buffer.from('first'), Buffer.from('second')]));
    expect(sockets[0].resumeCount).toBe(1);
    expect(sockets[0].isPaused).toBe(false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('retains buffered output across peer close and resolves close after drain', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const output: Buffer[] = [];
    terminalStreams.output.on('data', (chunk) => output.push(Buffer.from(chunk)));
    let writeCount = 0;
    const originalWrite = terminalStreams.stdout.write.bind(terminalStreams.stdout);
    terminalStreams.stdout.write = ((chunk: string | Uint8Array) => {
      writeCount += 1;
      originalWrite(chunk);
      return writeCount > 1;
    }) as typeof terminalStreams.stdout.write;
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emitMessage(Buffer.from('buffered'), true);
    sockets[0].close();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);
    expect(sockets[0].isPaused).toBe(true);

    terminalStreams.stdout.emit('drain');
    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'close' });
    expect(Buffer.concat(output)).toEqual(Buffer.from('buffered'));
  });

  it('uses exit code preferentially when exit and close arrive before output drains', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    let writeCount = 0;
    const originalWrite = terminalStreams.stdout.write.bind(terminalStreams.stdout);
    terminalStreams.stdout.write = ((chunk: string | Uint8Array) => {
      writeCount += 1;
      originalWrite(chunk);
      return writeCount > 1;
    }) as typeof terminalStreams.stdout.write;
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emitMessage(Buffer.from('buffered'), true);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 19 }), false);
    sockets[0].close();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);

    terminalStreams.stdout.emit('drain');
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 19 });
  });

  it('fails bounded output backpressure and has a finite drain fallback', async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const originalWrite = terminalStreams.stdout.write.bind(terminalStreams.stdout);
    terminalStreams.stdout.write = ((chunk: string | Uint8Array) => {
      originalWrite(chunk);
      return false;
    }) as typeof terminalStreams.stdout.write;
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      maxPendingOutputBytes: 8,
      backpressureTimeoutMs: 10,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    sockets[0].emitMessage(Buffer.from('12345'), true);
    sockets[0].emitMessage(Buffer.from('6789'), true);
    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(Buffer.concat(errors).toString()).toMatch(/output backpressure limit/);

    const fallbackSockets: FakeWebSocket[] = [];
    const fallbackTerminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        fallbackSockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const fallbackStreams = streams();
    const fallbackWrite = fallbackStreams.stdout.write.bind(fallbackStreams.stdout);
    fallbackStreams.stdout.write = ((chunk: string | Uint8Array) => {
      fallbackWrite(chunk);
      return false;
    }) as typeof fallbackStreams.stdout.write;
    const fallback = fallbackTerminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: fallbackStreams,
      signalSource: new EventEmitter(),
      backpressureTimeoutMs: 10,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(fallbackSockets[0]?.sent).toHaveLength(1));
    fallbackSockets[0].emitMessage(Buffer.from('stuck'), true);
    await expect(fallback).resolves.toEqual({ status: 'detached', reason: 'error' });
  });

  it('serializes stdin sends until the WebSocket send callback releases backpressure', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0].blockSends = true;

    terminalStreams.input.emit('data', Buffer.from('one'));
    terminalStreams.input.emit('data', Buffer.from('two'));
    expect(sockets[0].sent).toEqual([expect.any(String), Buffer.from('one')]);
    expect(terminalStreams.input.isPaused()).toBe(true);

    sockets[0].releaseSend();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(3));
    expect(sockets[0].sent[2]).toEqual(Buffer.from('two'));
    expect(terminalStreams.input.isPaused()).toBe(true);
    sockets[0].releaseSend();
    expect(terminalStreams.input.isPaused()).toBe(false);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('sustains many bounded input and output chunks and resumes after drain', async () => {
    const sockets: FakeWebSocket[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const writes: Buffer[] = [];
    let firstWrite = true;
    const originalWrite = terminalStreams.stdout.write.bind(terminalStreams.stdout);
    terminalStreams.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(Buffer.from(chunk));
      originalWrite(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    }) as typeof terminalStreams.stdout.write;
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      maxPendingInputBytes: 1024,
      maxPendingOutputBytes: 1024,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    const chunks = Array.from({ length: 100 }, (_, index) => Buffer.alloc(8, 65 + (index % 26)));

    sockets[0].blockSends = true;
    for (const chunk of chunks) sockets[0].emitMessage(chunk, true);
    for (const chunk of chunks) terminalStreams.input.emit('data', chunk);

    expect(writes).toHaveLength(1);
    expect(sockets[0].pauseCount).toBe(1);
    expect(sockets[0].isPaused).toBe(true);
    expect(sockets[0].sent).toHaveLength(2);
    expect(terminalStreams.input.isPaused()).toBe(true);

    terminalStreams.stdout.emit('drain');
    await vi.waitFor(() => expect(writes).toHaveLength(100));
    expect(sockets[0].resumeCount).toBe(1);
    expect(sockets[0].isPaused).toBe(false);

    for (let index = 0; index < chunks.length + 2; index += 1) sockets[0].releaseSend();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(101));
    expect(terminalStreams.input.isPaused()).toBe(false);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('bounds pending stdin bytes and reports overflow while restoring input flow', async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const initialFlowing = terminalStreams.input.readableFlowing;
    const initialPaused = terminalStreams.input.isPaused();
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      maxPendingInputBytes: 8,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0].blockSends = true;

    terminalStreams.input.emit('data', Buffer.from('1234'));
    terminalStreams.input.emit('data', Buffer.from('5678'));
    expect(terminalStreams.input.isPaused()).toBe(true);
    terminalStreams.input.emit('data', Buffer.from('9'));

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(Buffer.concat(errors).toString()).toMatch(/input backpressure limit/);
    expect(terminalStreams.input.readableFlowing).toBe(initialFlowing);
    expect(terminalStreams.input.isPaused()).toBe(initialPaused);
  });

  it.each(['SIGTERM', 'SIGHUP'] as const)('detaches on default %s without inventing unsupported protocol frames', async (signal) => {
    const sockets: FakeWebSocket[] = [];
    const signalSource = new EventEmitter();
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource,
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    signalSource.emit(signal);

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'signal' });
    expect(sockets[0].sent).toHaveLength(1);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('detaches configured termination signals without inventing unsupported protocol frames', async () => {
    const sockets: FakeWebSocket[] = [];
    const signalSource = new EventEmitter();
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource,
      detachSignals: ['SIGHUP', 'SIGTERM'],
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    signalSource.emit('SIGHUP');

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'signal' });
    expect(sockets[0].sent).toHaveLength(1);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('rejects invalid resize dimensions without sending a malformed frame', async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const signalSource = new EventEmitter();
    let size = { cols: 80, rows: 24 };
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource,
      getSize: () => size,
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    size = { cols: 0, rows: 24 };
    signalSource.emit('SIGWINCH');

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(sockets[0].sent).toHaveLength(1);
    expect(Buffer.concat(errors).toString()).toMatch(/positive integers/);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('clamps expired static timeout metadata to a safe nonzero delay', async () => {
    const sockets: FakeWebSocket[] = [];
    const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    const scheduler = {
      setTimeout: (callback: () => void, delay: number) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: { cancelled: boolean }) => {
        timer.cancelled = true;
      },
    };
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const resultPromise = terminal.attach({
      createdAt: new Date(Date.now() - 10_000),
      timeout: 100,
      extendTimeout: vi.fn(async () => {}),
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: streams(),
      signalSource: new EventEmitter(),
      timeoutExtension: { scheduler },
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));

    expect(timers[0].delay).toBe(1_000);
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('extends sandbox timeout on a cancellable schedule and stops extending after teardown', async () => {
    const sockets: FakeWebSocket[] = [];
    const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    const scheduler = {
      setTimeout: (callback: () => void, delay: number) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: { cancelled: boolean }) => {
        timer.cancelled = true;
      },
    };
    const extendTimeout = vi.fn(async () => {});
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      extendTimeout,
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      timeoutExtension: { scheduler, intervalMs: 25, extensionMs: 100 },
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(25);

    timers[0].callback();
    await vi.waitFor(() => expect(extendTimeout).toHaveBeenCalledWith(100, expect.anything()));
    await vi.waitFor(() => expect(timers).toHaveLength(2));

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
    expect(timers[1].cancelled).toBe(true);
    timers[1].callback();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(extendTimeout).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight timeout extension when the terminal exits', async () => {
    const sockets: FakeWebSocket[] = [];
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    let extensionSignal: AbortSignal | undefined;
    let resolveExtension: (() => void) | undefined;
    const scheduler = {
      setTimeout: (callback: () => void) => {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: { cancelled: boolean }) => {
        timer.cancelled = true;
      },
    };
    const extendTimeout = vi.fn(async (_duration: number, options?: { signal?: AbortSignal }) => {
      extensionSignal = options?.signal;
      await new Promise<void>((resolve) => {
        resolveExtension = resolve;
      });
    });
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      extendTimeout,
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: streams(),
      signalSource: new EventEmitter(),
      timeoutExtension: { scheduler, intervalMs: 25, extensionMs: 100 },
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));

    timers[0].callback();
    await vi.waitFor(() => expect(extendTimeout).toHaveBeenCalledOnce());
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await vi.waitFor(() => expect(extensionSignal?.aborted).toBe(true));
    resolveExtension?.();

    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('validates timeout intervals and clamps oversized scheduler delays', async () => {
    const sockets: FakeWebSocket[] = [];
    const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
    const scheduler = {
      setTimeout: (callback: () => void, delay: number) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: { cancelled: boolean }) => {
        timer.cancelled = true;
      },
    };
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const invalid = terminal.attach({
      extendTimeout: vi.fn(async () => {}),
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: streams(),
      signalSource: new EventEmitter(),
      timeoutExtension: { scheduler, intervalMs: 0 },
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await expect(invalid).resolves.toEqual({ status: 'detached', reason: 'error' });

    const valid = terminal.attach({
      extendTimeout: vi.fn(async () => {}),
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: streams(),
      signalSource: new EventEmitter(),
      timeoutExtension: { scheduler, intervalMs: 3_000_000_000 },
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0].delay).toBeLessThanOrEqual(2_147_000_000);
    sockets[1].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(valid).resolves.toEqual({ status: 'exited', code: 0 });
  });

  it('reports timeout extension failures and restores the terminal', async () => {
    const sockets: FakeWebSocket[] = [];
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    const scheduler = {
      setTimeout: (callback: () => void) => {
        const timer = { callback, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: { cancelled: boolean }) => {
        timer.cancelled = true;
      },
    };
    const errors: Buffer[] = [];
    const extendTimeout = vi.fn(async () => {
      throw new Error('timeout extension failed');
    });
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      extendTimeout,
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      timeoutExtension: { scheduler, intervalMs: 25, extensionMs: 100 },
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(timers).toHaveLength(1));

    timers[0].callback();

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    expect(Buffer.concat(errors).toString()).toMatch(/timeout extension failed/);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it.each(['close', 'error', 'abort'] as const)('reconnects after %s with a fresh interactive endpoint', async (failure) => {
    const sockets: FakeWebSocket[] = [];
    const openInteractive = vi.fn(async () => ({
      url: 'wss://interactive.example/session',
      token: `secret-${openInteractive.mock.calls.length}`,
    }));
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const sandbox = { cwd: '/vercel/sandbox/repository', openInteractive };
    const firstController = new AbortController();
    const firstStreams = streams(true);
    const first = terminal.attach(sandbox, {
      streams: firstStreams,
      signal: firstController.signal,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    if (failure === 'close') sockets[0].close();
    if (failure === 'error') sockets[0].emit('error', new Error('socket failed'));
    if (failure === 'abort') firstController.abort();
    await expect(first).resolves.toEqual({ status: 'detached', reason: failure });

    const secondStreams = streams(true);
    const second = terminal.attach(sandbox, {
      streams: secondStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 100, rows: 30 }),
    });
    await vi.waitFor(() => expect(sockets[1]?.sent).toHaveLength(1));
    sockets[1].emitMessage(JSON.stringify({ type: 'exit', code: 3 }), false);
    await expect(second).resolves.toEqual({ status: 'exited', code: 3 });
    expect(openInteractive).toHaveBeenCalledTimes(2);
    expect(sockets[0].url).not.toBe(sockets[1].url);
  });

  it('does not stop or delete the sandbox on any terminal detach path', async () => {
    const paths = ['close', 'error', 'abort', 'eof', 'escape', 'signal'] as const;
    for (const path of paths) {
      const sockets: FakeWebSocket[] = [];
      const signalSource = new EventEmitter();
      const controller = new AbortController();
      const stop = vi.fn();
      const deleteSandbox = vi.fn();
      const terminal = createVercelTerminalAdapter({
        createWebSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          queueMicrotask(() => socket.open());
          return socket;
        },
      });
      const terminalStreams = streams(true);
      const sandbox = {
        cwd: '/vercel/sandbox/repository',
        openInteractive: async () => ({ url: 'wss://interactive.example/session', token: 'secret' }),
        stop,
        delete: deleteSandbox,
      };
      const resultPromise = terminal.attach(sandbox, {
        streams: terminalStreams,
        signal: controller.signal,
        signalSource,
        getSize: () => ({ cols: 80, rows: 24 }),
      });
      await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
      if (path === 'close') sockets[0].close();
      if (path === 'error') sockets[0].emit('error', new Error('socket failed'));
      if (path === 'abort') controller.abort();
      if (path === 'eof') terminalStreams.input.emit('end');
      if (path === 'escape') terminalStreams.input.emit('data', Buffer.from([0x1d]));
      if (path === 'signal') signalSource.emit('SIGTERM');
      await expect(resultPromise).resolves.toMatchObject({ status: 'detached' });
      expect(stop).not.toHaveBeenCalled();
      expect(deleteSandbox).not.toHaveBeenCalled();
    }
  });

  it('opens independent clean sessions when a resumed handle is attached twice', async () => {
    const sockets: FakeWebSocket[] = [];
    const openInteractive = vi.fn(async () => ({
      url: 'wss://interactive.example/session',
      token: `secret-${openInteractive.mock.calls.length}`,
    }));
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams(true);
    const sandbox = { cwd: '/vercel/sandbox/repository', openInteractive };

    const first = terminal.attach(sandbox, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(first).resolves.toEqual({ status: 'exited', code: 0 });

    const second = terminal.attach(sandbox, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 100, rows: 30 }),
    });
    await vi.waitFor(() => expect(sockets[1]?.sent).toHaveLength(1));
    sockets[1].emitMessage(JSON.stringify({ type: 'exit', code: 3 }), false);
    await expect(second).resolves.toEqual({ status: 'exited', code: 3 });

    expect(openInteractive).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(JSON.parse(String(sockets[0].sent[0])).cols).toBe(80);
    expect(JSON.parse(String(sockets[1].sent[0])).cols).toBe(100);
    expect(terminalStreams.input.isRaw).toBe(false);
  });

  it('does not leak the interactive token through transport errors or frames', async () => {
    const token = 'secret token/with?query';
    const sockets: FakeWebSocket[] = [];
    const errors: Buffer[] = [];
    const terminal = createVercelTerminalAdapter({
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const terminalStreams = streams();
    terminalStreams.error.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    const resultPromise = terminal.attach({
      cwd: '/vercel/sandbox/repository',
      openInteractive: async () => ({ url: 'wss://interactive.example/session', token }),
    }, {
      streams: terminalStreams,
      signalSource: new EventEmitter(),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    expect(String(sockets[0].sent[0])).not.toContain(token);
    expect(String(sockets[0].sent[0])).not.toContain(encodeURIComponent(token));

    sockets[0].emit('error', new Error(`connection failed at ${sockets[0].url}`));

    await expect(resultPromise).resolves.toEqual({ status: 'detached', reason: 'error' });
    const renderedError = Buffer.concat(errors).toString();
    expect(renderedError).not.toContain(token);
    expect(renderedError).not.toContain(encodeURIComponent(token));
    expect(() => sockets[0].emit('error', new Error('late close error'))).not.toThrow();
  });
});
