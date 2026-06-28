/**
 * devbox rm — remove container, worktree, and branch.
 */
import type { LauncherContext } from '../lib/context.js';
import { containerForAll } from '../lib/docker.js';
import { branchToPath, resolveWorktreesDir, removeWorktree, deleteBranch, branchExists } from '../lib/worktree.js';
import { info } from '../lib/log.js';
import { existsSync } from 'node:fs';

export async function rm(ctx: LauncherContext, branch: string): Promise<number> {
  const { repoRoot, repoName, runner, env } = ctx;

  // Remove container (if any).
  const cid = await containerForAll(runner, branch);
  if (cid) {
    await runner.execQuiet('docker', ['rm', '-f', cid], {});
  }

  // Remove worktree.
  const worktreesDir = resolveWorktreesDir(repoRoot, env);
  const path = branchToPath(worktreesDir, repoName, branch);
  if (existsSync(path)) {
    await removeWorktree(runner, repoRoot, path);
    info(`removed worktree ${path}`);
  }

  // Delete branch (if it exists).
  if (await branchExists(runner, repoRoot, branch)) {
    await deleteBranch(runner, repoRoot, branch);
    info(`deleted branch ${branch}`);
  }

  info(`removed devbox for ${branch}`);
  return 0;
}
