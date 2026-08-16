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
  private readonly pendingCallbacks: Array<() => void> = [];

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(data: Buffer | string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    if (this.blockSends && callback) {
      this.pendingCallbacks.push(() => callback());
      return;
    }
    callback?.();
  }

  releaseSend(): void {
    this.pendingCallbacks.shift()?.();
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  emitMessage(data: Buffer | string, isBinary: boolean): void {
    this.emit('message', data, isBinary);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function streams(isTTY = false): VercelTerminalStreams & { input: PassThrough; output: PassThrough; error: PassThrough } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => void };
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

describe('Vercel terminal adapter', () => {
  it('opens an interactive endpoint and sends the official shell start frame', async () => {
    const token = 'token with spaces&symbols';
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
    expect(sockets[0].url).toBe(
      `wss://interactive.example/session?existing=1&token=${encodeURIComponent(token)}`,
    );
    expect(sockets[0].sent).toHaveLength(1);
    expect(JSON.parse(String(sockets[0].sent[0]))).toMatchObject({
      type: 'start',
      command: 'shell',
      args: [],
      cwd: '/vercel/sandbox/cloned-repository',
      cols: 120,
      rows: 40,
      env: expect.arrayContaining(['TERM=xterm-256color']),
    });

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

    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(false);
    terminalStreams.stdout.emit('drain');
    await vi.waitFor(() => expect(writes).toEqual([Buffer.from('first'), Buffer.from('second')]));
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
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

    sockets[0].releaseSend();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(3));
    expect(sockets[0].sent[2]).toEqual(Buffer.from('two'));
    sockets[0].releaseSend();
    sockets[0].emitMessage(JSON.stringify({ type: 'exit', code: 0 }), false);
    await expect(resultPromise).resolves.toEqual({ status: 'exited', code: 0 });
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
