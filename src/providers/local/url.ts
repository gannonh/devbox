/**
 * devbox url — print or open the noVNC URL.
 *
 * --url:  prints bare URL to stdout (pipe-friendly), clickable hint on stderr.
 * --open: opens the URL in a browser.
 */
import type { LauncherContext } from './context.js';
import { containerFor, novncUrlFor } from './docker.js';
import { hyperlink } from '../../lib/display.js';
import { info } from '../../lib/log.js';
import { ProviderOperationError } from '../types.js';

export async function url(ctx: LauncherContext, branch: string, open: boolean): Promise<number> {
  const { runner, stdout, stderr } = ctx;
  const cid = await containerFor(runner, branch);
  if (!cid) {
    throw new ProviderOperationError(`no running box for ${branch} (start it with: devbox ${branch})`);
  }

  const url = await novncUrlFor(runner, cid);

  if (open) {
    info(`opening ${url}`);
    const result = await runner.execQuiet('open', [url], {});
    if (result.code !== 0) {
      throw new ProviderOperationError(`could not open browser (URL: ${url}) — copy and paste the URL manually`);
    }
    return 0;
  }

  // Bare URL on stdout (copy/pipe friendly).
  stdout.write(`${url}\n`);
  // Clickable hint on stderr (only in a TTY).
  if ((stderr as NodeJS.WriteStream).isTTY) {
    stderr.write('  ');
    stderr.write(hyperlink(url, 'open in browser'));
    stderr.write('\n');
  }
  return 0;
}
