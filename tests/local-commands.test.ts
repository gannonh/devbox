import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { list } from '../src/providers/local/list.js';
import { up } from '../src/providers/local/up.js';
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
    stdin: new PassThrough(),
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

    expect(await list(ctx)).toBe(0);
    expect(output).toContain('(none)');
  });

  it('lists running, paused, and stopped containers distinctly', async () => {
    const shell = runner({
      execQuiet: vi.fn().mockResolvedValue({
        stdout: [
          'main\tdevbox-main\trunning',
          'feature/pause\tdevbox-pause\tpaused',
          'feature/stop\tdevbox-stop\texited',
        ].join('\n'),
        code: 0,
      }),
    });
    const ctx = context(shell);
    let output = '';
    ctx.stderr.on('data', (chunk) => { output += chunk.toString(); });

    expect(await list(ctx)).toBe(0);
    expect(output).toContain('main                   running');
    expect(output).toContain('feature/pause          paused');
    expect(output).toContain('resume with: devbox feature/pause --attach');
    expect(output).toContain('feature/stop           stopped');
    expect(output).toContain('start with: devbox feature/stop');
  });

  it('writes URL output to the caller-provided stdout stream', async () => {
    const shell = runner({
      execQuiet: vi.fn().mockResolvedValue({ stdout: 'cid\trunning\n', code: 0 }),
      exec: vi.fn().mockResolvedValue('/box'),
    });
    const ctx = context(shell);
    let output = '';
    ctx.stdout.on('data', (chunk) => { output += chunk.toString(); });

    expect(await url(ctx, 'feature', false)).toBe(0);
    expect(output).toBe('http://box.orb.local:6080/vnc.html\n');
  });

  it('passes the caller stderr stream to devcontainer up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-up-'));
    const worktrees = await mkdtemp(join(tmpdir(), 'devbox-worktrees-'));
    const worktree = join(worktrees, 'repo-feature');
    const envFile = join(root, '.env');
    await mkdir(join(worktree, '.devcontainer'), { recursive: true });
    await writeFile(join(worktree, '.devcontainer', 'devcontainer.json'), '{}\n');
    await writeFile(envFile, 'API_PASSWORD=dotenv-secret\n');

    let devcontainerStarted = false;
    let devcontainerArgs: string[] | undefined;
    let devcontainerOptions: Parameters<ShellRunner['execQuiet']>[2];
    const shell = runner({
      exec: vi.fn(async (command: string) => command === 'docker' ? '/box' : ''),
      execQuiet: vi.fn(async (command: string, args: string[], options) => {
        if (command === 'which') return { stdout: '/usr/bin/tool\n', code: 0 };
        if (command === 'devcontainer') {
          devcontainerArgs = args;
          devcontainerStarted = true;
          devcontainerOptions = options;
          return { stdout: 'build output\n', code: 0 };
        }
        if (command === 'docker' && args[0] === 'ps') {
          return { stdout: devcontainerStarted ? 'cid\trunning\n' : '', code: 0 };
        }
        return { stdout: '', code: 0 };
      }),
      spawnInherit: vi.fn().mockResolvedValue(0),
    });
    const ctx = context(shell);
    ctx.repoRoot = root;
    ctx.repoName = 'repo';
    ctx.env = { DEVBOX_WORKTREES_DIR: worktrees };
    ctx.envPath = envFile;

    try {
      expect(await up(ctx, 'feature')).toBe(0);
      expect(devcontainerOptions?.stderr).toBe(ctx.stderr);
      expect(devcontainerOptions?.streamStdoutTo?.stream).toBe(ctx.stderr);
      expect(devcontainerArgs).toEqual(expect.arrayContaining([
        '--secrets-file',
        expect.stringContaining('devbox-env-'),
      ]));
      expect(shell.spawnInherit).toHaveBeenCalledWith(
        'docker',
        [
          'exec', '-i', '-w', '/workspace', '-u', 'node', 'cid', 'bash', '-lc',
          expect.stringContaining('/home/node/.devbox/runtime/environment.sh'),
        ],
        {},
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktrees, { recursive: true, force: true });
    }
  });
});
