import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { list } from '../src/providers/local/list.js';
import { url } from '../src/providers/local/url.js';
import type { LauncherContext } from '../src/providers/local/context.js';
import type { ShellRunner } from '../src/lib/shell.js';

function runner(impl: Partial<ShellRunner>): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
    ...impl,
  };
}

function context(shell: ShellRunner): LauncherContext & { stdout: PassThrough; stderr: PassThrough } {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
    runner: shell,
    env: {},
    tty: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
}

describe('local command output', () => {
  it('writes list output to the caller-provided stderr stream', async () => {
    const shell = runner({
      execQuiet: vi.fn().mockResolvedValue({ stdout: '', code: 0 }),
    });
    const ctx = context(shell);
    let output = '';
    ctx.stderr.on('data', (chunk) => { output += chunk.toString(); });

    expect(await list(ctx, ctx.stderr)).toBe(0);
    expect(output).toContain('(none)');
  });

  it('writes URL output to the caller-provided stdout stream', async () => {
    const shell = runner({
      execQuiet: vi.fn().mockResolvedValue({ stdout: 'cid\n', code: 0 }),
      exec: vi.fn().mockResolvedValue('/box'),
    });
    const ctx = context(shell);
    let output = '';
    ctx.stdout.on('data', (chunk) => { output += chunk.toString(); });

    expect(await url(ctx, 'feature', false)).toBe(0);
    expect(output).toBe('http://box.orb.local:6080/vnc.html\n');
  });
});
