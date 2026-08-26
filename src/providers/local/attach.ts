/**
 * devbox attach — re-enter a running box.
 *
 * If the box is running: exec in. If stopped: start it, re-bring display up,
 * exec in. If no box exists: error.
 */
import type { LauncherContext } from './context.js';
import { containerState } from './docker.js';
import { info, warn } from '../../lib/log.js';
import { localFailure } from './errors.js';
import { execIntoShell, requestedEnvironment, syncLocalEnvironment } from './up.js';

export async function attach(ctx: LauncherContext, branch: string): Promise<number> {
  const { runner, tty } = ctx;
  const runtimeEnvironment = await requestedEnvironment(ctx);

  const container = await containerState(runner, branch);
  switch (container.kind) {
    case 'running':
      info(`attaching to running box for ${branch}`);
      if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, container.id, runtimeEnvironment);
      return execIntoShell(runner, container.id, tty);
    case 'paused':
      info(`resuming paused box for ${branch}`);
      await runner.exec('docker', ['unpause', container.id], {});
      if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, container.id, runtimeEnvironment);
      return execIntoShell(runner, container.id, tty);
    case 'stopped': {
      info(`starting stopped box for ${branch}`);
      await runner.exec('docker', ['start', container.id], {});
      const displayResult = await runner.execQuiet(
        'docker',
        ['exec', '-u', 'node', container.id, 'bash', '-lc', 'setsid bash -c /usr/local/bin/devbox-start-display </dev/null >/tmp/devbox-display.log 2>&1 || true'],
        {},
      );
      if (displayResult.code !== 0) {
        warn('display stack restart may have failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, container.id, runtimeEnvironment);
      return execIntoShell(runner, container.id, tty);
    }
    case 'missing':
      return localFailure(`no box for ${branch} (start it with: devbox ${branch})`);
    default: {
      const _exhaustive: never = container;
      return _exhaustive;
    }
  }
}
