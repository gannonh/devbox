import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ShellRunner } from '../src/lib/shell.js';
import { attach } from '../src/providers/local/attach.js';
import type { LauncherContext } from '../src/providers/local/context.js';
import { pause } from '../src/providers/local/pause.js';
import { stop } from '../src/providers/local/stop.js';
import { up } from '../src/providers/local/up.js';

function runner(impl: Partial<ShellRunner>): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
    ...impl,
  };
}

function context(shell: ShellRunner): LauncherContext {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
    runner: shell,
    env: {},
    tty: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
}

function pausedRunner(): ShellRunner {
  return runner({
    exec: vi.fn().mockResolvedValue(''),
    execQuiet: vi.fn(async (command: string) => {
      if (command === 'which') return { stdout: '/usr/bin/tool\n', code: 0 };
      return { stdout: 'cid\tpaused\n', code: 0 };
    }),
    spawnInherit: vi.fn().mockResolvedValue(0),
  });
}

function expectNoDisplayRestart(shell: ShellRunner): void {
  const restartedDisplay = vi.mocked(shell.execQuiet).mock.calls.some(
    ([command, args]) => command === 'docker'
      && args.some((arg) => arg.includes('devbox-start-display')),
  );
  expect(restartedDisplay).toBe(false);
}

describe('local pause lifecycle', () => {
  it('pauses a running container with docker pause', async () => {
    const shell = runner({
      exec: vi.fn().mockResolvedValue(''),
      execQuiet: vi.fn().mockResolvedValue({ stdout: 'cid\trunning\n', code: 0 }),
    });

    await expect(pause(context(shell), 'feature')).resolves.toBe(0);
    expect(shell.exec).toHaveBeenCalledWith('docker', ['pause', 'cid'], {});
  });

  it('leaves an already paused container paused', async () => {
    const shell = pausedRunner();

    await expect(pause(context(shell), 'feature')).resolves.toBe(0);
    expect(shell.exec).not.toHaveBeenCalled();
  });

  it('unpauses on attach without restarting the display', async () => {
    const shell = pausedRunner();

    await expect(attach(context(shell), 'feature')).resolves.toBe(0);
    expect(shell.exec).toHaveBeenCalledWith('docker', ['unpause', 'cid'], {});
    expectNoDisplayRestart(shell);
    expect(shell.spawnInherit).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['exec', 'cid']),
      {},
    );
  });

  it('unpauses on normal up without restarting the display', async () => {
    const shell = pausedRunner();

    await expect(up(context(shell), 'feature')).resolves.toBe(0);
    expect(shell.exec).toHaveBeenCalledWith('docker', ['unpause', 'cid'], {});
    expectNoDisplayRestart(shell);
    expect(shell.spawnInherit).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['exec', 'cid']),
      {},
    );
  });

  it('keeps stop mapped to docker stop for a paused container', async () => {
    const shell = pausedRunner();

    await expect(stop(context(shell), 'feature')).resolves.toBe(0);
    expect(shell.exec).toHaveBeenCalledWith('docker', ['stop', 'cid'], {});
  });
});
