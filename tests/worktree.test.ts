import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, chmodSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { branchToPath, resolveWorktreesDir, createWorktree, removeWorktree, branchExists, defaultBranch, stripBranchRef, ensureWorktreeConfig, resolveWorktreeStartPoint } from '../src/providers/local/worktree.js';
import type { ShellRunner } from '../src/lib/shell.js';

function mockShell(impl: Partial<ShellRunner>): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
    ...impl,
  } as ShellRunner;
}

describe('branchToPath', () => {
  it('joins worktrees dir, repo name, and branch with a dash', () => {
    expect(branchToPath('/worktrees', 'my-repo', 'my-feature')).toBe(
      '/worktrees/my-repo-my-feature',
    );
  });

  it('uses DEVBOX_WORKTREES_DIR when set', () => {
    expect(branchToPath('/custom/dir', 'app', 'dev')).toBe('/custom/dir/app-dev');
  });
});

describe('resolveWorktreesDir', () => {
  it('returns DEVBOX_WORKTREES_DIR env when set', () => {
    const dir = resolveWorktreesDir('/Volumes/EVO/dev/my-repo', { DEVBOX_WORKTREES_DIR: '/custom' });
    expect(dir).toBe('/custom');
  });

  it('defaults to dirname of repo root', () => {
    const dir = resolveWorktreesDir('/Volumes/EVO/dev/my-repo', {});
    expect(dir).toBe('/Volumes/EVO/dev');
  });
});

describe('stripBranchRef', () => {
  it('strips refs/remotes/origin/ from origin HEAD', () => {
    expect(stripBranchRef('refs/remotes/origin/main\n')).toBe('main');
  });

  it('strips refs/heads/ from local HEAD', () => {
    expect(stripBranchRef('refs/heads/master')).toBe('master');
  });

  it('keeps slashes in the remaining branch name', () => {
    expect(stripBranchRef('refs/remotes/origin/release/1.x')).toBe('release/1.x');
  });
});

describe('defaultBranch', () => {
  it('returns the origin HEAD branch (stripped of refs/remotes/origin/)', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: 'refs/remotes/origin/main\n', code: 0 });
    const runner = mockShell({ execQuiet });
    expect(await defaultBranch(runner, '/repo')).toBe('main');
    expect(execQuiet).toHaveBeenCalledWith(
      'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: '/repo', silentStderr: true },
    );
  });

  it('falls back to local HEAD when origin HEAD is not set', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: '', code: 1 }) // origin HEAD fails
      .mockResolvedValueOnce({ stdout: 'refs/heads/master\n', code: 0 }); // local HEAD
    const runner = mockShell({ execQuiet });
    expect(await defaultBranch(runner, '/repo')).toBe('master');
  });

  it('falls back to "main" when neither origin nor local HEAD resolves', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: '', code: 1 });
    const runner = mockShell({ execQuiet });
    expect(await defaultBranch(runner, '/repo')).toBe('main');
  });
});

describe('resolveWorktreeStartPoint', () => {
  it('uses origin/<default> after a successful fetch', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main\n', code: 0 }) // defaultBranch
      .mockResolvedValueOnce({ stdout: '', code: 0 }) // origin/main exists
      .mockResolvedValueOnce({ stdout: '0\n', code: 0 }); // local not ahead
    const runner = mockShell({ execQuiet });

    expect(await resolveWorktreeStartPoint(runner, '/repo', {}, { fetched: true })).toEqual({
      ref: 'origin/main',
    });
  });

  it('uses origin/<default> when local default is ahead, and warns', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main\n', code: 0 })
      .mockResolvedValueOnce({ stdout: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '2\n', code: 0 });
    const runner = mockShell({ execQuiet });

    const result = await resolveWorktreeStartPoint(runner, '/repo', {}, { fetched: true });
    expect(result.ref).toBe('origin/main');
    expect(result.warning).toContain('2 commits');
    expect(result.warning).toContain('origin/main');
  });

  it('falls back to the local default branch when fetch failed', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main\n', code: 0 });
    const runner = mockShell({ execQuiet });

    const result = await resolveWorktreeStartPoint(runner, '/repo', {}, { fetched: false });
    expect(result.ref).toBe('main');
    expect(result.warning).toContain('git fetch origin main failed');
  });

  it('uses the local default branch when DEVBOX_START_POINT=local', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main\n', code: 0 });
    const runner = mockShell({ execQuiet });

    expect(
      await resolveWorktreeStartPoint(
        runner,
        '/repo',
        { DEVBOX_START_POINT: 'local' },
        { fetched: true },
      ),
    ).toEqual({ ref: 'main' });
    expect(execQuiet).toHaveBeenCalledTimes(1);
  });

  it('falls back to local when origin/<default> does not exist', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: 'refs/remotes/origin/main\n', code: 0 })
      .mockResolvedValueOnce({ stdout: '', code: 1 });
    const runner = mockShell({ execQuiet });

    const result = await resolveWorktreeStartPoint(runner, '/repo', {}, { fetched: true });
    expect(result.ref).toBe('main');
    expect(result.warning).toContain('origin/main');
  });
});

describe('createWorktree', () => {
  it('creates a new branch from the given start point when branch does not exist', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: '', code: 0 }) // prune (succeeds)
      .mockResolvedValueOnce({ stdout: '', code: 1 }); // branch does not exist
    const exec = vi.fn().mockResolvedValue('');
    const runner = mockShell({ exec, execQuiet });

    await createWorktree(runner, {
      repoRoot: '/repo',
      path: '/worktrees/repo-dev',
      branch: 'dev',
      startPoint: 'origin/main',
    });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--relative-paths', '-b', 'dev', '/worktrees/repo-dev', 'origin/main'],
      { cwd: '/repo' },
    );
  });

  it('creates a new branch from origin/master when that is the start point', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: '', code: 0 }) // prune (succeeds)
      .mockResolvedValueOnce({ stdout: '', code: 1 }); // branch does not exist
    const exec = vi.fn().mockResolvedValue('');
    const runner = mockShell({ exec, execQuiet });

    await createWorktree(runner, {
      repoRoot: '/repo',
      path: '/worktrees/repo-dev',
      branch: 'dev',
      startPoint: 'origin/master',
    });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--relative-paths', '-b', 'dev', '/worktrees/repo-dev', 'origin/master'],
      { cwd: '/repo' },
    );
  });

  it('reuses existing branch when it already exists', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: '', code: 0 }) // prune (succeeds)
      .mockResolvedValueOnce({ stdout: '', code: 0 }); // branch exists
    const exec = vi.fn().mockResolvedValue('');
    const runner = mockShell({ exec, execQuiet });

    await createWorktree(runner, {
      repoRoot: '/repo',
      path: '/worktrees/repo-dev',
      branch: 'dev',
      startPoint: 'origin/main',
    });

    // worktree add without -b flag (reuse existing branch)
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--relative-paths', '/worktrees/repo-dev', 'dev'],
      { cwd: '/repo' },
    );
  });
});

describe('removeWorktree', () => {
  it('calls git worktree remove --force, falls back to rm -rf', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: '', code: 0 }) // worktree remove succeeds
      .mockResolvedValue({ stdout: '', code: 0 });
    const runner = mockShell({ execQuiet });

    const result = await removeWorktree(runner, '/repo', '/worktrees/repo-dev');
    expect(result).toBe(true);
    expect(execQuiet).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/worktrees/repo-dev'],
      { cwd: '/repo', silentStderr: true },
    );
  });

  it('falls back to rm -rf when git worktree remove fails', async () => {
    const execQuiet = vi.fn()
      .mockResolvedValueOnce({ stdout: '', code: 1 }) // git worktree remove fails
      .mockResolvedValueOnce({ stdout: '', code: 0 }); // rm -rf succeeds
    const runner = mockShell({ execQuiet });

    const result = await removeWorktree(runner, '/repo', '/worktrees/repo-dev');
    expect(result).toBe(true);
  });
});

describe('branchExists', () => {
  it('returns true when show-ref succeeds', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: '', code: 0 });
    const runner = mockShell({ execQuiet });
    expect(await branchExists(runner, '/repo', 'dev')).toBe(true);
  });

  it('returns false when show-ref fails', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: '', code: 1 });
    const runner = mockShell({ execQuiet });
    expect(await branchExists(runner, '/repo', 'dev')).toBe(false);
  });
});

describe('ensureWorktreeConfig', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function writeInitFiles(root: string): void {
    mkdirSync(join(root, '.devbox'), { recursive: true });
    mkdirSync(join(root, '.devcontainer'), { recursive: true });
    writeFileSync(join(root, '.devbox', 'provision.sh'), '#!/bin/sh\n');
    chmodSync(join(root, '.devbox', 'provision.sh'), 0o755);
    writeFileSync(join(root, '.devcontainer', 'devcontainer.json'), '{}\n');
  }

  it('is a no-op when the worktree already has devcontainer.json', async () => {
    const repo = tempDir('devbox-src-');
    const worktree = tempDir('devbox-wt-');
    writeInitFiles(worktree);

    expect(await ensureWorktreeConfig(repo, worktree)).toEqual({ status: 'ok' });
  });

  it('copies untracked .devbox/ and .devcontainer/ from the source checkout', async () => {
    const repo = tempDir('devbox-src-');
    const worktree = tempDir('devbox-wt-');
    writeInitFiles(repo);

    expect(await ensureWorktreeConfig(repo, worktree)).toEqual({ status: 'copied' });
    expect(await readFile(join(worktree, '.devcontainer', 'devcontainer.json'), 'utf8')).toBe('{}\n');
    expect(await readFile(join(worktree, '.devbox', 'provision.sh'), 'utf8')).toBe('#!/bin/sh\n');
  });

  it('returns missing when init has not been run in the source repo', async () => {
    const repo = tempDir('devbox-src-');
    const worktree = tempDir('devbox-wt-');

    const result = await ensureWorktreeConfig(repo, worktree);
    expect(result).toMatchObject({
      status: 'missing',
      message: expect.stringContaining('no .devcontainer/devcontainer.json'),
    });
    expect(existsSync(join(worktree, '.devcontainer'))).toBe(false);
  });
});
