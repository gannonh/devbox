import type { LauncherContext } from './context.js';
import { containerState } from './docker.js';
import { info, warn } from '../../lib/log.js';

export async function pause(ctx: LauncherContext, branch: string): Promise<number> {
  const container = await containerState(ctx.runner, branch);
  switch (container.kind) {
    case 'running':
      await ctx.runner.exec('docker', ['pause', container.id], {});
      info('paused (worktree and container kept; --attach to resume)');
      return 0;
    case 'paused':
      info('already paused');
      return 0;
    case 'stopped':
      warn(`box for ${branch} is stopped; nothing to pause`);
      return 0;
    case 'missing':
      warn(`no container for branch ${branch}`);
      return 0;
    default: {
      const _exhaustive: never = container;
      return _exhaustive;
    }
  }
}
