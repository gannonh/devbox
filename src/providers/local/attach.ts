/**
 * devbox attach — re-enter a running box.
 *
 * If the box is running: exec in. If stopped: start it, re-bring display up,
 * exec in. If no box exists: error.
 */
import type { LauncherContext } from './context.js';
import { containerFor, containerForAll } from './docker.js';
import { info, warn } from '../../lib/log.js';
import { localFailure } from './errors.js';
import { execIntoShell, requestedEnvironment, syncLocalEnvironment } from './up.js';

export async function attach(ctx: LauncherContext, branch: string): Promise<number> {
  const { runner, tty } = ctx;
  const runtimeEnvironment = await requestedEnvironment(ctx);

  // Running box: attach directly.
  const runningCid = await containerFor(runner, branch);
  if (runningCid) {
    info(`attaching to running box for ${branch}`);
    if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, runningCid, runtimeEnvironment);
    return execIntoShell(runner, runningCid, tty);
  }

  // Stopped box: start it, re-bring display, attach.
  const stoppedCid = await containerForAll(runner, branch);
  if (stoppedCid) {
    info(`starting stopped box for ${branch}`);
    await runner.exec('docker', ['start', stoppedCid], {});
    // Re-bring the display stack up. setsid so it survives this exec session.
    const displayResult = await runner.execQuiet(
      'docker',
      ['exec', '-u', 'node', stoppedCid, 'bash', '-lc', 'setsid bash -c /usr/local/bin/devbox-start-display </dev/null >/tmp/devbox-display.log 2>&1 || true'],
      {},
    );
    if (displayResult.code !== 0) {
      warn('display stack restart may have failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (ctx.envPath !== undefined || ctx.runtimeEnvironment !== undefined) await syncLocalEnvironment(runner, stoppedCid, runtimeEnvironment);
    return execIntoShell(runner, stoppedCid, tty);
  }

  localFailure(`no box for ${branch} (start it with: devbox ${branch})`);
}