/**
 * devbox stop — stop the box (keeps worktree + container).
 */
import type { LauncherContext } from '../lib/context.js';
import { containerForAll } from '../lib/docker.js';
import { warn, info } from '../lib/log.js';

export async function stop(ctx: LauncherContext, branch: string): Promise<number> {
  const { runner } = ctx;
  const cid = await containerForAll(runner, branch);
  if (!cid) {
    warn(`no container for branch ${branch}`);
    return 0;
  }
  await runner.exec('docker', ['stop', cid], {});
  info('stopped (worktree kept; --attach to resume)');
  return 0;
}
