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
 * Resolve the repo's default branch.
 *
 * Tries `git symbolic-ref refs/remotes/origin/HEAD` first (the upstream
 * default), falls back to `git symbolic-ref HEAD` (the local default), and
 * finally defaults to 'main' if neither resolves (e.g. a fresh repo with no
 * remote). Strips the `refs/heads/` prefix.
 */
export async function defaultBranch(
  runner: ShellRunner,
  repoRoot: string,
): Promise<string> {
  // Try origin HEAD first.
  let result = await runner.execQuiet(
    'git', ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { cwd: repoRoot, silentStderr: true },
  );
  if (result.code === 0) {
    return result.stdout.trim().replace(/^refs\/heads\//, '');
  }
  // Fall back to local HEAD.
  result = await runner.execQuiet(
    'git', ['symbolic-ref', 'HEAD'],
    { cwd: repoRoot, silentStderr: true },
  );
  if (result.code === 0) {
    return result.stdout.trim().replace(/^refs\/heads\//, '');
  }
  // Final fallback.
  return 'main';
}

/**
 * Create a worktree for a branch. If the branch already exists, reuse it.
 * If not, create a new branch from the repo's default branch (resolved
 * dynamically — not hardcoded to 'main', so repos with 'master' or other
 * default branches work correctly).
 *
 * Uses --relative-paths so the .git pointer resolves inside the container.
 */
export async function createWorktree(runner: ShellRunner, config: WorktreeConfig): Promise<void> {
  // Prune stale worktree registrations (dirs deleted manually, etc.) so the
  // add doesn't fail with "missing but already registered worktree".
  await runner.execQuiet('git', ['worktree', 'prune'], { cwd: config.repoRoot, silentStderr: true });

  const exists = await branchExists(runner, config.repoRoot, config.branch);
  if (exists) {
    await runner.exec('git', ['worktree', 'add', '--relative-paths', config.path, config.branch], {
      cwd: config.repoRoot,
    });
  } else {
    const base = await defaultBranch(runner, config.repoRoot);
    await runner.exec(
      'git',
      ['worktree', 'add', '--relative-paths', '-b', config.branch, config.path, base],
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
    silentStderr: true,
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
