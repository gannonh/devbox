/**
 * devbox attach — re-enter a running box.
 *
 * If the box is running: exec in. If stopped: start it, re-bring display up,
 * exec in. If no box exists: error.
 */
import type { LauncherContext } from '../lib/context.js';
import { containerFor, containerForAll } from '../lib/docker.js';
import { info, die } from '../lib/log.js';

export async function attach(ctx: LauncherContext, branch: string): Promise<number> {
  const { runner, tty } = ctx;

  // Running box: attach directly.
  const runningCid = await containerFor(runner, branch);
  if (runningCid) {
    info(`attaching to running box for ${branch}`);
    const ttyFlag = tty ? '-it' : '-i';
    return runner.spawnInherit('docker', ['exec', ttyFlag, '-w', '/workspace', '-u', 'node', runningCid, 'bash', '-l'], {});
  }

  // Stopped box: start it, re-bring display, attach.
  const stoppedCid = await containerForAll(runner, branch);
  if (stoppedCid) {
    info(`starting stopped box for ${branch}`);
    await runner.exec('docker', ['start', stoppedCid], {});
    await runner.execQuiet(
      'docker',
      ['exec', '-u', 'node', stoppedCid, 'bash', '-lc', 'setsid bash -c /usr/local/bin/devbox-start-display </dev/null >/tmp/devbox-display.log 2>&1 || true'],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const ttyFlag = tty ? '-it' : '-i';
    return runner.spawnInherit('docker', ['exec', ttyFlag, '-w', '/workspace', '-u', 'node', stoppedCid, 'bash', '-l'], {});
  }

  die(`no box for ${branch} (start it with: devbox ${branch})`);
}
