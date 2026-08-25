import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  assertTerminalLongevityBudget,
  runInteractiveTerminal,
  runTerminalLongevity,
  waitForOutput,
} from '../scripts/vercel/smoke-terminal.mjs';
import type { VercelTerminalOptions, VercelTerminalResult } from '../src/providers/vercel/terminal.js';

describe('provider smoke output waiting', () => {
  it('holds one attachment idle for six minutes before proving server output and client input', async () => {
    const signalController = new AbortController();
    const report: Record<string, unknown> = {};
    const writes: string[] = [];
    const observedAtWrite: number[] = [];
    let nowMs = 1_000;
    const terminalAdapter = {
      attach: vi.fn(async (_sandbox: unknown, options: VercelTerminalOptions = {}) => new Promise<VercelTerminalResult>((resolve) => {
        const streams = options.streams!;
        streams.stdin.on('data', (chunk: Buffer) => {
          const input = Buffer.from(chunk);
          if (input.includes(0x1d)) {
            resolve({ status: 'detached', reason: 'escape' });
            return;
          }
          writes.push(input.toString());
          observedAtWrite.push(nowMs);
          if (writes.length === 1) {
            expect(input.toString()).toContain('sleep 360');
            expect(input.toString()).not.toContain('client-input-unique');
            nowMs += 360_001;
            streams.stdout.write('server-marker-unique\n');
          } else {
            streams.stdout.write('server-echo:client-input-unique\n');
          }
        });
      })),
    };
    const sandboxObservations = [
      {
        id: 'sbox_raw_identifier',
        name: 'devbox-smoke-consumer-secret-name',
        interactiveUrl: 'wss://interactive.example/session?token=raw-endpoint-secret',
        interactiveToken: 'raw-interactive-token',
        status: 'running',
        expiresAt: new Date('2026-08-25T20:00:00.000Z'),
      },
      {
        id: 'sbox_raw_identifier',
        name: 'devbox-smoke-consumer-secret-name',
        interactiveUrl: 'wss://interactive.example/session?token=raw-endpoint-secret',
        interactiveToken: 'raw-interactive-token',
        status: 'running',
        expiresAt: new Date('2026-08-25T20:10:00.000Z'),
      },
    ];
    let observationIndex = 0;
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    await runTerminalLongevity({
      sandbox: sandboxObservations[0],
      refreshSandbox: async () => sandboxObservations[observationIndex++],
      report,
      signal: signalController.signal,
      terminalAdapter,
      idleMs: 360_000,
      terminalTimeoutMs: 1_000,
      now: () => nowMs,
      markers: {
        server: 'server-marker-unique',
        input: 'client-input-unique',
        echoPrefix: 'server-echo:',
      },
      recordCheck: (_target: unknown, name: string, ok: boolean, detail: string) => {
        checks.push({ name, ok, detail });
        if (!ok) throw new Error(detail);
      },
    });

    expect(terminalAdapter.attach).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(2);
    expect(observedAtWrite).toEqual([1_000, 361_001]);
    expect(JSON.stringify(report)).not.toContain('sbox_raw_identifier');
    expect(JSON.stringify(report)).not.toContain('devbox-smoke-consumer-secret-name');
    expect(JSON.stringify(report)).not.toContain('raw-endpoint-secret');
    expect(JSON.stringify(report)).not.toContain('raw-interactive-token');
    expect(report.terminalLongevity).toEqual(expect.objectContaining({
      idleTargetMs: 360_000,
      idleObservedMs: 360_001,
      serverMarkerObserved: true,
      clientInputEchoObserved: true,
      before: expect.objectContaining({ status: 'running', expiresAt: '2026-08-25T20:00:00.000Z' }),
      after: expect.objectContaining({ status: 'running', expiresAt: '2026-08-25T20:10:00.000Z' }),
    }));
    expect(checks.map((check) => check.name)).toEqual([
      'six-minute terminal idle interval',
      'post-idle server marker',
      'post-idle client input echo',
      'terminal longevity Sandbox evidence',
      'terminal longevity clean detach',
    ]);
  });

  it('aborts and awaits the attachment when longevity verification fails', async () => {
    const callerController = new AbortController();
    let attachmentSignal: AbortSignal | undefined;
    let attachmentSettled = false;
    const terminalAdapter = {
      attach: vi.fn(async (_sandbox: unknown, options: VercelTerminalOptions = {}) => new Promise<VercelTerminalResult>((resolve) => {
        const streams = options.streams;
        const signal = options.signal;
        if (!streams || !signal) throw new Error('terminal attachment options are required');
        attachmentSignal = signal;
        streams.stdin.once('data', () => {
          streams.stdout.write('server-marker\n');
        });
        signal.addEventListener('abort', () => {
          setImmediate(() => {
            attachmentSettled = true;
            resolve({ status: 'detached', reason: 'abort' });
          });
        }, { once: true });
      })),
    };

    await expect(runTerminalLongevity({
      sandbox: {},
      refreshSandbox: async () => ({ status: 'running', expiresAt: new Date() }),
      report: {},
      signal: callerController.signal,
      terminalAdapter,
      idleMs: 1,
      terminalTimeoutMs: 100,
      now: (() => {
        let current = 0;
        return () => ++current;
      })(),
      markers: { server: 'server-marker', input: 'input-marker', echoPrefix: 'echo:' },
      recordCheck: () => {
        throw new Error('longevity verification failed');
      },
    })).rejects.toThrow('longevity verification failed');

    expect(attachmentSignal).not.toBe(callerController.signal);
    expect(attachmentSignal?.aborted).toBe(true);
    expect(attachmentSettled).toBe(true);
  });

  it('preserves the verification failure when attachment cleanup also fails', async () => {
    const terminalAdapter = {
      attach: vi.fn(async (_sandbox: unknown, options: VercelTerminalOptions = {}) => new Promise<VercelTerminalResult>((_resolve, reject) => {
        const streams = options.streams!;
        streams.stdin.once('data', () => streams.stdout.write('server-marker\n'));
        options.signal!.addEventListener('abort', () => reject(new Error('attachment cleanup failed')), { once: true });
      })),
    };

    await expect(runTerminalLongevity({
      sandbox: {},
      refreshSandbox: async () => ({ status: 'running', expiresAt: new Date() }),
      report: {},
      terminalAdapter,
      idleMs: 1,
      terminalTimeoutMs: 100,
      now: (() => {
        let current = 0;
        return () => ++current;
      })(),
      markers: { server: 'server-marker', input: 'input-marker', echoPrefix: 'echo:' },
      recordCheck: () => {
        throw new Error('longevity verification failed');
      },
    })).rejects.toThrow('longevity verification failed');
  });

  it('rejects a terminal longevity run that cannot fit inside the smoke deadline', () => {
    expect(() => assertTerminalLongevityBudget({
      deadlineAt: 10_000,
      idleMs: 6_000,
      timeoutMs: 3_000,
      now: () => 2_000,
    })).toThrow('remaining smoke budget 8000ms is below the required 9000ms');

    expect(() => assertTerminalLongevityBudget({
      deadlineAt: 11_000,
      idleMs: 6_000,
      timeoutMs: 3_000,
      now: () => 2_000,
    })).not.toThrow();
  });

  it('uses exactly one production terminal adapter call for the ready/interrupt flow', async () => {
    const signalController = new AbortController();
    const pathReport = { label: 'existing', checks: [] as unknown[] };
    let escapeFrame: Buffer | undefined;
    const terminalAdapter = {
      attach: vi.fn(async (_sandbox: unknown, options: VercelTerminalOptions = {}) => new Promise<VercelTerminalResult>((resolve) => {
        const streams = options.streams!;
        const signalSource = options.signalSource!;
        let commandCount = 0;
        streams.stdin.on('data', (chunk: Buffer) => {
          const input = Buffer.from(chunk);
          if (input.includes(0x1d)) {
            escapeFrame = input;
            resolve({ status: 'detached', reason: 'escape' });
            return;
          }
          commandCount += 1;
          const command = input.toString();
          if (commandCount === 1) {
            streams.stdout.write('provider-smoke-ready-existing\\n');
          } else if (command.includes('sleep 30')) {
            streams.stdout.write('provider-smoke-sleeping-existing\\n');
          } else if (command.includes('provider-smoke-after-interrupt-existing')) {
            streams.stdout.write('provider-smoke-after-interrupt-existing\\n');
          }
        });
        signalSource.once('SIGINT', () => {
          streams.stdout.write('provider-smoke-interrupted-existing\\n');
        });
      })),
    };

    await runInteractiveTerminal({
      sandbox: {},
      pathReport,
      signal: signalController.signal,
      terminalAdapter,
      cloneCwd: '/vercel/sandbox/repo',
      terminalTimeoutMs: 1_000,
      recordCheck: (target: any, name: string, ok: boolean, detail: string) => {
        target.checks.push({ name, ok, detail });
        if (!ok) throw new Error(detail);
      },
    });

    expect(terminalAdapter.attach).toHaveBeenCalledOnce();
    expect(terminalAdapter.attach).toHaveBeenCalledWith({}, expect.objectContaining({ cwd: '/vercel/sandbox/repo' }));
    expect(escapeFrame).toEqual(Buffer.from([0x1d]));
    expect(pathReport.checks).toEqual([
      expect.objectContaining({ name: 'openInteractive terminal', ok: true }),
      expect.objectContaining({ name: 'Ctrl-C terminal protocol', ok: true }),
      expect.objectContaining({ name: 'Ctrl-] terminal protocol', ok: true }),
    ]);
  });

  it('resolves from a data marker and removes its listener exactly once', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const resultPromise = waitForOutput(stream, 'ready', 1_000, controller.signal);

    stream.write('prefix-ready');

    await expect(resultPromise).resolves.toBe('prefix-ready');
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('does not miss a marker emitted while checking captured output', async () => {
    const stream = new PassThrough();

    await expect(waitForOutput(stream, 'ready', 1_000, undefined, () => {
      stream.emit('data', 'ready');
      return '';
    })).resolves.toBe('ready');
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('merges a marker split across captured output and a chunk emitted during the check', async () => {
    const stream = new PassThrough();

    await expect(waitForOutput(stream, 'prefix-ready', 1_000, undefined, () => {
      stream.emit('data', 'ready');
      return 'prefix-';
    })).resolves.toBe('prefix-ready');
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('keeps chunks emitted during the check when captured output is empty', async () => {
    const stream = new PassThrough();

    await expect(waitForOutput(stream, 'ready', 1_000, undefined, () => {
      stream.emit('data', 'ready');
      return '';
    })).resolves.toBe('ready');
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('does not duplicate a chunk the captured snapshot already ends with', async () => {
    const stream = new PassThrough();
    const seen: string[] = [];
    stream.on('data', (chunk: Buffer) => seen.push(chunk.toString()));

    await expect(waitForOutput(stream, 'ready', 1_000, undefined, () => {
      stream.emit('data', 'ready');
      return seen.join('');
    })).resolves.toBe('ready');
    expect(stream.listenerCount('data')).toBe(1);
  });

  it('handles a marker already present in the captured output after installing listeners', async () => {
    const stream = new PassThrough();

    await expect(waitForOutput(stream, 'ready', 1_000, undefined, () => 'already-ready'))
      .resolves.toBe('already-ready');
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('rejects on abort and cleans the data listener', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const resultPromise = waitForOutput(stream, 'ready', 1_000, controller.signal);

    controller.abort(new Error('cancelled'));

    await expect(resultPromise).rejects.toThrow('cancelled');
    expect(stream.listenerCount('data')).toBe(0);
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('clears its timer exactly once when a marker settles the wait', async () => {
    const stream = new PassThrough();
    const timers: Array<() => void> = [];
    let clearCount = 0;
    const resultPromise = waitForOutput(stream, 'ready', 1_000, undefined, () => '', {
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => {
        clearCount += 1;
      },
    });

    stream.write('ready');

    await expect(resultPromise).resolves.toBe('ready');
    expect(timers).toHaveLength(1);
    expect(clearCount).toBe(1);
  });

  it('rejects on timeout and clears the timer once', async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const resultPromise = waitForOutput(stream, 'ready', 25);
      const rejection = expect(resultPromise).rejects.toThrow(/did not contain ready/);

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(stream.listenerCount('data')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
