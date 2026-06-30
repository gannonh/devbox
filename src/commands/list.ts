/**
 * devbox list — list devbox containers + noVNC URLs.
 */
import type { LauncherContext } from '../lib/context.js';
import { hyperlink } from '../lib/display.js';
import { info, setLogStreams } from '../lib/log.js';
import type { Writable } from 'node:stream';

interface ContainerRow {
  branch: string;
  name: string;
  state: string;
}

export async function list(ctx: LauncherContext, stderr?: Writable): Promise<number> {
  const { repoName, runner } = ctx;

  if (stderr) setLogStreams({ stderr });

  info('devbox containers:');

  // Query all containers with the devbox.repo label for this repo.
  // Format: branch\tname\tstate
  const result = await runner.execQuiet(
    'docker',
    ['ps', '-a', '--filter', `label=devbox.repo=${repoName}`, '--format', '{{.Label "devbox.branch"}}\t{{.Names}}\t{{.State}}'],
    {},
  );

  if (!result.stdout.trim()) {
    process.stderr.write('  (none)\n');
    return 0;
  }

  const rows: ContainerRow[] = result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [branch, name, state] = line.split('\t');
      return { branch, name, state };
    });

  for (const row of rows) {
    if (!row.name) continue;
    if (row.state === 'running') {
      const url = `http://${row.name}.orb.local:6080/vnc.html`;
      process.stderr.write(`  ${row.branch.padEnd(22)} ${row.state.padEnd(9)} `);
      process.stderr.write(hyperlink(url, url));
      process.stderr.write('\n');
    } else {
      process.stderr.write(
        `  ${row.branch.padEnd(22)} ${row.state.padEnd(9)} (stopped — start with: devbox ${row.branch})\n`,
      );
    }
  }

  return 0;
}
