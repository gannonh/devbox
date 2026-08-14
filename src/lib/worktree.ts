/**
 * Worktree path math and git worktree operations.
 *
 * Port of the bash devbox.sh worktree functions. The key difference from
 * plain `git worktree add` is `--relative-paths`, which makes the .git
 * pointer resolve both on the host and inside the container.
 */
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ShellRunner } from './shell.js';
import { warn } from './log.js';

export interface WorktreeConfig {
  repoRoot: string;
  path: string;
  branch: string;
  /** Commit-ish to branch from when the branch does not already exist. */
  startPoint: string;
}

export interface WorktreeStartPoint {
  ref: string;
  warning?: string;
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
 * Strip git ref prefixes down to the branch name.
 *
 * `git symbolic-ref refs/remotes/origin/HEAD` prints
 * `refs/remotes/origin/main` (not `refs/heads/main`). Local HEAD prints
 * `refs/heads/main`. Keep slashes in the remainder (`release/1.x`).
 */
export function stripBranchRef(ref: string): string {
  const trimmed = ref.trim();
  const prefixes = ['refs/remotes/origin/', 'refs/heads/'] as const;
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

/**
 * Resolve the repo's default branch.
 *
 * Tries `git symbolic-ref refs/remotes/origin/HEAD` first (the upstream
 * default), falls back to `git symbolic-ref HEAD` (the local default), and
 * finally defaults to 'main' if neither resolves (e.g. a fresh repo with no
 * remote).
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
    return stripBranchRef(result.stdout);
  }
  // Fall back to local HEAD.
  result = await runner.execQuiet(
    'git', ['symbolic-ref', 'HEAD'],
    { cwd: repoRoot, silentStderr: true },
  );
  if (result.code === 0) {
    return stripBranchRef(result.stdout);
  }
  // Final fallback.
  return 'main';
}

/**
 * Pick the commit a new worktree should start from.
 *
 * After a successful fetch, prefer `origin/<default>` so the box is not
 * stuck on a stale local default branch. `DEVBOX_START_POINT=local` keeps
 * the old behavior. Fetch failure or a missing origin ref falls back to
 * the local default. Local-only commits are left on local `main`; the new
 * branch still starts from origin, with a warning.
 */
export async function resolveWorktreeStartPoint(
  runner: ShellRunner,
  repoRoot: string,
  env: Record<string, string | undefined>,
  opts: { fetched: boolean },
): Promise<WorktreeStartPoint> {
  const branch = await defaultBranch(runner, repoRoot);
  if (env.DEVBOX_START_POINT === 'local') {
    return { ref: branch };
  }

  if (!opts.fetched) {
    return {
      ref: branch,
      warning: `git fetch origin ${branch} failed (offline?); using local ${branch}`,
    };
  }

  const originRef = `origin/${branch}`;
  const originExists = await runner.execQuiet(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    { cwd: repoRoot, silentStderr: true },
  );
  if (originExists.code !== 0) {
    return {
      ref: branch,
      warning: `no ${originRef}; using local ${branch}`,
    };
  }

  const ahead = await runner.execQuiet(
    'git',
    ['rev-list', '--count', `${originRef}..${branch}`],
    { cwd: repoRoot, silentStderr: true },
  );
  const count = Number.parseInt(ahead.stdout.trim(), 10);
  if (ahead.code === 0 && count > 0) {
    const commits = count === 1 ? '1 commit' : `${count} commits`;
    return {
      ref: originRef,
      warning: `local ${branch} has ${commits} not on ${originRef}; new worktree starts from ${originRef}`,
    };
  }

  return { ref: originRef };
}

export type EnsureWorktreeConfigResult =
  | { status: 'ok' }
  | { status: 'copied' }
  | { status: 'missing'; message: string };

/**
 * Make sure a worktree has the files `devcontainer up` needs.
 *
 * `git worktree add` only checks out committed files, so a just-inited repo
 * (untracked `.devbox/` + `.devcontainer/`) would otherwise boot a worktree
 * with no `devcontainer.json`. Copy those trees from the source checkout
 * when the worktree is missing them.
 */
export async function ensureWorktreeConfig(
  repoRoot: string,
  worktreePath: string,
): Promise<EnsureWorktreeConfigResult> {
  const destJson = join(worktreePath, '.devcontainer', 'devcontainer.json');
  if (existsSync(destJson)) return { status: 'ok' };

  const srcJson = join(repoRoot, '.devcontainer', 'devcontainer.json');
  if (!existsSync(srcJson)) {
    return {
      status: 'missing',
      message:
        'no .devcontainer/devcontainer.json in this worktree or the source repo. Run `npx @gannonh/devbox init` first, then retry.',
    };
  }

  const srcDevbox = join(repoRoot, '.devbox');
  if (existsSync(srcDevbox)) {
    await cp(srcDevbox, join(worktreePath, '.devbox'), { recursive: true });
  }
  await cp(join(repoRoot, '.devcontainer'), join(worktreePath, '.devcontainer'), {
    recursive: true,
  });
  return { status: 'copied' };
}

/**
 * Create a worktree for a branch. If the branch already exists, reuse it.
 * If not, create a new branch from `config.startPoint` (typically
 * `origin/<default>` after fetch).
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
    await runner.exec(
      'git',
      ['worktree', 'add', '--relative-paths', '-b', config.branch, config.path, config.startPoint],
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
  warn(`git worktree remove failed for ${path}; falling back to rm -rf`);
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
