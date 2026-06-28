import { describe, it, expect, vi } from 'vitest';
import { branchToPath, resolveWorktreesDir, createWorktree, removeWorktree, branchExists } from '../src/lib/worktree.js';
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

describe('createWorktree', () => {
  it('creates a new branch from main when branch does not exist', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: '', code: 1 }); // branch does not exist
    const exec = vi.fn().mockResolvedValue('');
    const runner = mockShell({ exec, execQuiet });

    await createWorktree(runner, {
      repoRoot: '/repo',
      path: '/worktrees/repo-dev',
      branch: 'dev',
    });

    // First call: check branch existence (show-ref)
    expect(execQuiet).toHaveBeenCalledWith('git', ['show-ref', '--verify', '--quiet', 'refs/heads/dev'], { cwd: '/repo' });
    // Second call: worktree add -b
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '--relative-paths', '-b', 'dev', '/worktrees/repo-dev', 'main'],
      { cwd: '/repo' },
    );
  });

  it('reuses existing branch when it already exists', async () => {
    const execQuiet = vi.fn().mockResolvedValue({ stdout: '', code: 0 }); // branch exists
    const exec = vi.fn().mockResolvedValue('');
    const runner = mockShell({ exec, execQuiet });

    await createWorktree(runner, {
      repoRoot: '/repo',
      path: '/worktrees/repo-dev',
      branch: 'dev',
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
