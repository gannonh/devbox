import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runInteractiveTerminal, waitForOutput } from '../scripts/vercel/smoke-terminal.mjs';
import type { VercelTerminalOptions, VercelTerminalResult } from '../src/providers/vercel/terminal.js';

describe('provider smoke output waiting', () => {
  it('uses exactly one production terminal adapter call for the ready/interrupt flow', async () => {
    const signalController = new AbortController();
    const pathReport = { label: 'existing', checks: [] as unknown[] };
    const terminalAdapter = {
      attach: vi.fn(async (_sandbox: unknown, options: VercelTerminalOptions = {}) => new Promise<VercelTerminalResult>((resolve) => {
        const streams = options.streams!;
        const signalSource = options.signalSource!;
        let commandCount = 0;
        streams.stdin.on('data', (chunk: Buffer) => {
          commandCount += 1;
          const command = chunk.toString();
          if (commandCount === 1) {
            streams.stdout.write('provider-smoke-ready-existing\\n');
          } else if (command.includes('sleep 30')) {
            streams.stdout.write('provider-smoke-sleeping-existing\\n');
          } else if (command.includes('exit')) {
            resolve({ status: 'exited', code: 0 });
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
    expect(pathReport.checks).toEqual([
      expect.objectContaining({ name: 'openInteractive terminal', ok: true }),
      expect.objectContaining({ name: 'Ctrl-C terminal protocol', ok: true }),
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
