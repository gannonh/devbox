/**
 * devbox url — print or open the noVNC URL.
 *
 * --url:  prints bare URL to stdout (pipe-friendly), clickable hint on stderr.
 * --open: opens the URL in a browser.
 */
import type { LauncherContext } from '../lib/context.js';
import { containerFor, novncUrlFor } from '../lib/docker.js';
import { hyperlink } from '../lib/display.js';
import { info, die } from '../lib/log.js';

export async function url(ctx: LauncherContext, branch: string, open: boolean): Promise<number> {
  const { runner } = ctx;
  const cid = await containerFor(runner, branch);
  if (!cid) {
    die(`no running box for ${branch} (start it with: devbox ${branch})`);
  }

  const url = await novncUrlFor(runner, cid);

  if (open) {
    info(`opening ${url}`);
    const result = await runner.execQuiet('open', [url], {});
    if (result.code !== 0) {
      die(`could not open browser (URL: ${url})`);
    }
    return 0;
  }

  // Bare URL on stdout (copy/pipe friendly).
  process.stdout.write(`${url}\n`);
  // Clickable hint on stderr (only in a TTY).
  if (process.stderr.isTTY) {
    process.stderr.write('  ');
    process.stderr.write(hyperlink(url, 'open in browser'));
    process.stderr.write('\n');
  }
  return 0;
}
