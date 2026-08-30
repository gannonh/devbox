import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runInteractiveTerminal, waitForOutput } from '../scripts/vercel/smoke-terminal.mjs';
import type { VercelTerminalOptions, VercelTerminalResult } from '../src/providers/vercel/terminal.js';

describe('provider smoke terminal driver', () => {
  it('uses one production terminal adapter call for the ready, interrupt, and escape flow', async () => {
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
          if (commandCount === 1) streams.stdout.write('provider-smoke-ready-existing\n');
          else if (command.includes('sleep 30')) streams.stdout.write('provider-smoke-sleeping-existing\n');
          else if (command.includes('provider-smoke-after-interrupt-existing')) {
            streams.stdout.write('provider-smoke-after-interrupt-existing\n');
          }
        });
        signalSource.once('SIGINT', () => streams.stdout.write('provider-smoke-interrupted-existing\n'));
      })),
    };

    await runInteractiveTerminal({
      sandbox: {},
      pathReport,
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

  it('retries the ready marker without creating another terminal attachment', async () => {
    const pathReport = { label: 'missing', checks: [] as unknown[] };
    let readyWrites = 0;
    const terminalAdapter = {
      attach: vi.fn(async (_sandbox: unknown, options: VercelTerminalOptions = {}) => new Promise<VercelTerminalResult>((resolve) => {
        const streams = options.streams!;
        const signalSource = options.signalSource!;
        streams.stdin.on('data', (chunk: Buffer) => {
          const input = Buffer.from(chunk);
          if (input.includes(0x1d)) {
            resolve({ status: 'detached', reason: 'escape' });
            return;
          }
          const command = input.toString();
          if (command.includes('sleep 30')) {
            streams.stdout.write('provider-smoke-sleeping-missing\n');
            return;
          }
          if (command.includes('provider-smoke-after-interrupt-missing')) {
            streams.stdout.write('provider-smoke-after-interrupt-missing\n');
            return;
          }
          readyWrites += 1;
          if (readyWrites >= 3) streams.stdout.write('provider-smoke-ready-missing\n');
        });
        signalSource.once('SIGINT', () => streams.stdout.write('provider-smoke-interrupted-missing\n'));
      })),
    };

    await runInteractiveTerminal({
      sandbox: {},
      pathReport,
      terminalAdapter,
      cloneCwd: '/vercel/sandbox/repo',
      terminalTimeoutMs: 5_000,
      readyRetryIntervalMs: 20,
      recordCheck: (target: any, name: string, ok: boolean, detail: string) => {
        target.checks.push({ name, ok, detail });
        if (!ok) throw new Error(detail);
      },
    });

    expect(readyWrites).toBeGreaterThanOrEqual(3);
    expect(terminalAdapter.attach).toHaveBeenCalledOnce();
  });

  it('surfaces an early attach failure before waiting for terminal output', async () => {
    const pathReport = { label: 'existing', checks: [] as unknown[] };
    const terminalAdapter = {
      attach: vi.fn(async (_sandbox: unknown, options: VercelTerminalOptions = {}) => {
        options.onError?.({ message: 'openInteractive failed' } as never);
        return { status: 'detached', reason: 'error' } as VercelTerminalResult;
      }),
    };

    await expect(runInteractiveTerminal({
      sandbox: {},
      pathReport,
      terminalAdapter,
      cloneCwd: '/vercel/sandbox/repo',
      terminalTimeoutMs: 1_000,
      recordCheck: () => {},
    })).rejects.toThrow(/openInteractive failed|settled early/);
    expect(pathReport.checks).toEqual([]);
  });
});

describe('provider smoke output waiting', () => {
  it('resolves from a marker and removes its data listener', async () => {
    const stream = new PassThrough();
    const resultPromise = waitForOutput(stream, 'ready', 1_000);

    stream.write('prefix-ready');

    await expect(resultPromise).resolves.toBe('prefix-ready');
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('does not miss a marker emitted while reading captured output', async () => {
    const stream = new PassThrough();

    await expect(waitForOutput(stream, 'prefix-ready', 1_000, undefined, () => {
      stream.emit('data', 'ready');
      return 'prefix-';
    })).resolves.toBe('prefix-ready');
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('rejects on abort and clears the data listener', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const resultPromise = waitForOutput(stream, 'ready', 1_000, controller.signal);

    controller.abort(new Error('cancelled'));

    await expect(resultPromise).rejects.toThrow('cancelled');
    expect(stream.listenerCount('data')).toBe(0);
  });
});
