/**
 * Worktree path math and git worktree operations.
 *
 * Port of the bash devbox.sh worktree functions. The key difference from
 * plain `git worktree add` is `--relative-paths`, which makes the .git
 * pointer resolve both on the host and inside the container.
 */
import { dirname, join } from 'node:path';
import type { ShellRunner } from './shell.js';

export interface WorktreeConfig {
  repoRoot: string;
  path: string;
  branch: string;
}

/**
 * Resolve the worktrees directory.
 * Uses DEVBOX_WORKTREES_DIR if set, otherwise defaults to dirname(repoRoot).
 */
export function resolveWorktreesDir(repoRoot: string, env: Record<string, string | undefined>): string {
  if (env.DEVBOX_WORKTREES_DIR) return env.DEVBOX_WORKTREES_DIR;
  return dirname(repoRoot);
}

/**
 * Compute the worktree path for a branch.
 * Pattern: <worktreesDir>/<repoName>-<branch>
 */
export function branchToPath(worktreesDir: string, repoName: string, branch: string): string {
  return join(worktreesDir, `${repoName}-${branch}`);
}

/**
 * Check if a local branch exists.
 */
export async function branchExists(
  runner: ShellRunner,
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  const result = await runner.execQuiet('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
  });
  return result.code === 0;
}

/**
 * Create a worktree for a branch. If the branch already exists, reuse it.
 * If not, create a new branch from main.
 *
 * Uses --relative-paths so the .git pointer resolves inside the container.
 */
export async function createWorktree(runner: ShellRunner, config: WorktreeConfig): Promise<void> {
  const exists = await branchExists(runner, config.repoRoot, config.branch);
  if (exists) {
    await runner.exec('git', ['worktree', 'add', '--relative-paths', config.path, config.branch], {
      cwd: config.repoRoot,
    });
  } else {
    await runner.exec(
      'git',
      ['worktree', 'add', '--relative-paths', '-b', config.branch, config.path, 'main'],
      { cwd: config.repoRoot },
    );
  }
}

/**
 * Remove a worktree. Tries `git worktree remove --force`, falls back to rm -rf.
 * @returns true if the worktree was removed (or didn't exist).
 */
export async function removeWorktree(runner: ShellRunner, repoRoot: string, path: string): Promise<boolean> {
  const result = await runner.execQuiet('git', ['worktree', 'remove', '--force', path], {
    cwd: repoRoot,
  });
  if (result.code === 0) return true;
  // Fallback: rm -rf
  const rmResult = await runner.execQuiet('rm', ['-rf', path], {});
  return rmResult.code === 0;
}

/**
 * Delete a local branch.
 */
export async function deleteBranch(runner: ShellRunner, repoRoot: string, branch: string): Promise<boolean> {
  const result = await runner.execQuiet('git', ['branch', '-D', branch], { cwd: repoRoot });
  return result.code === 0;
}
