/**
 * devbox list — list devbox containers + noVNC URLs.
 */
import type { LauncherContext } from './context.js';
import { hyperlink } from '../../lib/display.js';
import { info, setLogStreams } from '../../lib/log.js';
interface ContainerRow {
  branch: string;
  name: string;
  state: 'running' | 'paused' | 'stopped';
}

function localState(state: string): ContainerRow['state'] {
  if (state === 'running' || state === 'paused') return state;
  return 'stopped';
}

export async function list(ctx: LauncherContext): Promise<number> {
  const { repoName, runner, stderr } = ctx;

  const output = stderr;
  setLogStreams({ stderr });

  info('devbox containers:');

  // Query all containers with the devbox.repo label for this repo.
  // Format: branch\tname\tstate
  const result = await runner.execQuiet(
    'docker',
    ['ps', '-a', '--filter', `label=devbox.repo=${repoName}`, '--format', '{{.Label "devbox.branch"}}\t{{.Names}}\t{{.State}}'],
    {},
  );

  if (!result.stdout.trim()) {
    output.write('  (none)\n');
    return 0;
  }

  const rows: ContainerRow[] = result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [branch = '', name = '', state = ''] = line.split('\t');
      return { branch, name, state: localState(state) };
    });

  for (const row of rows) {
    if (!row.name) continue;
    switch (row.state) {
      case 'running': {
        const url = `http://${row.name}.orb.local:6080/vnc.html`;
        output.write(`  ${row.branch.padEnd(22)} ${row.state.padEnd(9)} `);
        output.write(hyperlink(url, url));
        output.write('\n');
        break;
      }
      case 'paused':
        output.write(
          `  ${row.branch.padEnd(22)} ${row.state.padEnd(9)} (resume with: devbox ${row.branch} --attach)\n`,
        );
        break;
      case 'stopped':
        output.write(
          `  ${row.branch.padEnd(22)} ${row.state.padEnd(9)} (start with: devbox ${row.branch})\n`,
        );
        break;
      default: {
        const _exhaustive: never = row.state;
        void _exhaustive;
      }
    }
  }

  return 0;
}
