import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Contract tests for the in-Sandbox relay control script.
 *
 * The manager treats this script's output as evidence -- a published listener
 * port, and a PID/start-time-verified health answer -- so the script is
 * exercised for real against the actual relay process rather than mocked.
 */
const CONTROL = 'images/vercel/app-relay-control.sh';
const RELAY = 'images/vercel/app-relay.mjs';

const run = promisify(execFile);
const started: number[] = [];
let relayDir = '';

afterEach(async () => {
  if (relayDir) await control(['stop-all']).catch(() => undefined);
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: stop-all is expected to have taken it.
    }
  }
});

async function control(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<string> {
  const result = await run('bash', [CONTROL, ...args], {
    env: {
      ...process.env,
      DEVBOX_RELAY_DIR: relayDir,
      DEVBOX_RELAY_SCRIPT: join(process.cwd(), RELAY),
      ...env,
    },
  });
  return result.stdout;
}

function records(output: string): Array<Record<string, number | boolean>> {
  return output
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, number | boolean>);
}

async function newRelayDir(): Promise<string> {
  relayDir = await mkdtemp(join(tmpdir(), 'devbox-relay-control-'));
  return relayDir;
}

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('app relay control script', () => {
  it('publishes a bound listener and reports it healthy', async () => {
    await newRelayDir();

    const start = records(await control(['start', '5173', '-', '-']));
    started.push(start[0].pid as number);

    expect(start).toHaveLength(1);
    expect(start[0].logicalPort).toBe(5173);
    // Publication follows the bind: the port is already accepting connections
    // by the time the manager could put it in a route.
    expect(await reachable(start[0].relayPort as number)).toBe(true);
    expect(records(await control(['status']))).toEqual([
      { logicalPort: 5173, relayPort: start[0].relayPort, pid: start[0].pid, running: true },
    ]);
  });

  it('keeps display credentials out of the relay process environment', async () => {
    await newRelayDir();

    const start = records(await control(['start', '5173', '-', '-'], {
      DEVBOX_NOVNC_PASSWORD: 'display-access-code',
      DEVBOX_NOVNC_PORT: '6080',
    }));
    started.push(start[0].pid as number);
    const environment = await readFile(`/proc/${start[0].pid}/environ`, 'utf8');

    expect(environment).toContain('DEVBOX_RELAY_TARGET_PORT=5173');
    // An app relay has no business holding the display credential, and the
    // control script is where that is enforced.
    expect(environment).not.toContain('display-access-code');
    expect(environment).not.toContain('DEVBOX_NOVNC_PASSWORD');
  });

  it('reports a vanished process as unhealthy rather than trusting its record', async () => {
    await newRelayDir();
    const start = records(await control(['start', '5173', '-', '-']));
    process.kill(start[0].pid as number, 'SIGKILL');
    // Wait for the kernel to reap it so /proc no longer answers for the PID.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const status = records(await control(['status']));

    expect(status).toEqual([{ logicalPort: 5173, relayPort: 0, pid: 0, running: false }]);
  });

  it('rejects a record whose PID was reused by another process', async () => {
    await newRelayDir();
    // A plausible-looking record for a live PID that is not a relay: the
    // start-time and command-line checks are what make this fail closed.
    await writeFile(join(relayDir, '5173.pid'), `${process.pid} 1 app-relay.mjs 5173 45173\n`);

    expect(records(await control(['status']))).toEqual([
      { logicalPort: 5173, relayPort: 0, pid: 0, running: false },
    ]);
  });

  it('stops a relay and leaves no process, listener, or state behind', async () => {
    await newRelayDir();
    const start = records(await control(['start', '5173', '-', '-']));
    const port = start[0].relayPort as number;

    await control(['stop', '5173']);

    expect(records(await control(['status']))).toEqual([]);
    expect(await reachable(port)).toBe(false);
    expect((await readdir(relayDir)).filter((entry) => entry.endsWith('.pid'))).toEqual([]);
  });

  it('replaces a running relay when the same port is started again', async () => {
    await newRelayDir();
    const first = records(await control(['start', '5173', '-', '-']));
    const second = records(await control(['start', '5173', '-', '-']));
    started.push(second[0].pid as number);

    expect(second[0].pid).not.toBe(first[0].pid);
    expect(records(await control(['status']))).toHaveLength(1);
  });
});
