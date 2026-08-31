import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  parseRelayRecords,
  provisionRelays,
  readRelayProcesses,
  stopAllRelays,
  stopRelays,
  verifyRelayMappings,
  RELAY_CONTROL_PATH,
  RELAY_SCRIPT_PATH,
  RELAY_START_ATTEMPTS,
  VercelRelayError,
} from '../src/providers/vercel/app-relay.js';
import type {
  VercelCommandResult,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
  VercelWriteFile,
} from '../src/providers/vercel/client.js';

interface FakeOptions {
  /** Live relays keyed by logical port. */
  running?: Record<number, number>;
  /** Ports the fake kernel hands back, in order, ignoring the forbidden list. */
  offers?: number[];
  startExitCode?: number;
  statusExitCode?: number;
}

function fakeClient(options: FakeOptions = {}) {
  const commands: string[][] = [];
  const files: VercelWriteFile[] = [];
  const running = new Map<number, number>(
    Object.entries(options.running ?? {}).map(([logical, relay]) => [Number(logical), relay]),
  );
  const offers = [...(options.offers ?? [])];

  const client = {
    writeFiles: vi.fn(async (_sandbox: VercelSandboxHandle, written: VercelWriteFile[]) => {
      files.push(...written);
    }),
    runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      const args = (request.args ?? []).slice(1);
      commands.push([...args]);
      const [command, ...rest] = args;
      if (command === 'status') {
        return {
          exitCode: options.statusExitCode ?? 0,
          stdout: async () => [...running].map(([logical, relay]) =>
            `{"logicalPort":${logical},"relayPort":${relay},"pid":${1000 + logical},"running":true}`).join('\n'),
        } as unknown as VercelCommandResult;
      }
      if (command === 'stop' || command === 'stop-all') {
        if (command === 'stop-all') running.clear();
        else for (const port of rest) running.delete(Number(port));
        return { exitCode: 0, stdout: async () => '' } as unknown as VercelCommandResult;
      }
      const logical = Number(rest[0]);
      const preferred = rest[1] === '-' ? undefined : Number(rest[1]);
      const relayPort = offers.length > 0 ? offers.shift()! : preferred ?? 40_000 + logical;
      running.set(logical, relayPort);
      return {
        exitCode: options.startExitCode ?? 0,
        stdout: async () =>
          `[devbox-relay-control] starting\n{"logicalPort":${logical},"relayPort":${relayPort},"pid":7}\n`,
      } as unknown as VercelCommandResult;
    }),
  } as unknown as VercelSandboxClient;

  return { client, commands, files, running };
}

const sandbox = {
  name: 'devbox-vercel-test',
  routes: [],
  currentSession: () => ({ sessionId: 'relay-session' }),
} as unknown as VercelSandboxHandle;

function manager(options: FakeOptions = {}) {
  const fake = fakeClient(options);
  return { ...fake, options: { sandbox, client: fake.client } };
}

describe('relay record parsing', () => {
  it('reads JSON lines and ignores everything else on the stream', () => {
    const records = parseRelayRecords([
      '[devbox-relay-control] starting 5173',
      '{"logicalPort":5173,"relayPort":45173,"pid":9,"running":true}',
      'not json',
      '{"logicalPort":3000,"relayPort":0,"pid":0,"running":false}',
    ].join('\n'));

    expect(records).toEqual([
      { logicalPort: 5173, relayPort: 45173, pid: 9, running: true },
      { logicalPort: 3000, relayPort: 0, pid: 0, running: false },
    ]);
  });

  it('treats an unusable port as not running rather than as evidence', () => {
    expect(parseRelayRecords('{"logicalPort":5173,"relayPort":"45173","running":true}')).toEqual([
      { logicalPort: 5173, relayPort: 0, pid: 0, running: false },
    ]);
    expect(parseRelayRecords('{"logicalPort":0,"relayPort":45173,"running":true}')).toEqual([]);
  });
});

describe('relay provisioning', () => {
  it('installs the relay runtime and starts one process per app port', async () => {
    const { options, commands, files } = manager();

    const result = await provisionRelays(options, {
      logical: [{ port: 5173, label: 'vite' }, { port: 3000, label: 'next' }],
    });

    expect(files.map((file) => file.path)).toEqual([RELAY_SCRIPT_PATH, RELAY_CONTROL_PATH]);
    expect(files[0].content.equals(await readFile('images/vercel/app-relay.mjs'))).toBe(true);
    expect(files[1].content.equals(await readFile('images/vercel/app-relay-control.sh'))).toBe(true);
    expect(result.mappings).toEqual([
      { logicalPort: 5173, relayPort: 45_173, label: 'vite' },
      { logicalPort: 3000, relayPort: 43_000, label: 'next' },
    ]);
    expect(result.started).toEqual([5173, 3000]);
    expect(commands.filter(([command]) => command === 'start')).toHaveLength(2);
  });

  it('forbids display ports, app ports, foreign routes, and sibling listeners', async () => {
    const { options, commands } = manager();

    await provisionRelays(options, {
      logical: [{ port: 5173, label: 'vite' }, { port: 3000, label: 'next' }],
      routePorts: [6080, 7777],
    });

    const forbidden = commands
      .filter(([command]) => command === 'start')
      .map(([, , , list]) => list.split(',').map(Number));
    expect(forbidden[0]).toEqual(expect.arrayContaining([5900, 6080, 6081, 3000, 7777]));
    // The first relay's listener joins the list before the second one binds.
    expect(forbidden[1]).toEqual(expect.arrayContaining([45_173]));
    // A relay never gets its own app port in the forbidden list; the process
    // refuses that target itself, and listing it would be a contradiction.
    expect(forbidden[0]).not.toContain(5173);
  });

  it('keeps a live sibling relay out of a new listener allocation', async () => {
    const { options, commands } = manager({ running: { 5173: 45_173 } });

    await provisionRelays(options, {
      logical: [{ port: 3000, label: 'next' }],
      routePorts: [6080, 45_173],
    });

    const start = commands.find(([command]) => command === 'start');
    expect(start?.[3].split(',').map(Number)).toContain(45_173);
  });

  it('reuses a live relay instead of restarting it', async () => {
    const { options, commands } = manager({ running: { 5173: 45_173 } });

    const result = await provisionRelays(options, {
      logical: [{ port: 5173, label: 'vite' }],
      existing: [{ logicalPort: 5173, relayPort: 45_173, label: 'vite' }],
      routePorts: [6080, 45_173],
    });

    expect(result.started).toEqual([]);
    expect(result.mappings).toEqual([{ logicalPort: 5173, relayPort: 45_173, label: 'vite' }]);
    expect(commands.filter(([command]) => command === 'start')).toEqual([]);
  });

  it('prefers the recorded listener port when the process has to be rebuilt', async () => {
    const { options, commands } = manager();

    await provisionRelays(options, {
      logical: [{ port: 5173, label: 'vite' }],
      existing: [{ logicalPort: 5173, relayPort: 49_999, label: 'vite' }],
      // The route naming the recorded port is ours; it must not be treated as
      // a collision, or every resume would regenerate the URL.
      routePorts: [6080, 49_999],
    });

    expect(commands.filter(([command]) => command === 'start')[0].slice(0, 3))
      .toEqual(['start', '5173', '49999']);
  });

  it('refuses a listener the Sandbox reports on a forbidden port', async () => {
    // Every attempt reports 6080, which no route may ever point at.
    const { options, commands } = manager({ offers: [6080, 6080, 6080, 6080] });

    await expect(provisionRelays(options, { logical: [{ port: 5173, label: 'vite' }] }))
      .rejects.toBeInstanceOf(VercelRelayError);
    expect(commands.filter(([command]) => command === 'start')).toHaveLength(RELAY_START_ATTEMPTS);
  });

  it('retries a failed start within the bounded attempt count', async () => {
    const { options, commands } = manager({ offers: [5173, 46_000] });

    const result = await provisionRelays(options, { logical: [{ port: 5173, label: 'vite' }] });

    expect(result.mappings).toEqual([{ logicalPort: 5173, relayPort: 46_000, label: 'vite' }]);
    expect(commands.filter(([command]) => command === 'start')).toHaveLength(2);
  });

  it('does nothing at all when no app port was selected', async () => {
    const { options, commands, files } = manager();

    await expect(provisionRelays(options, { logical: [] }))
      .resolves.toEqual({ mappings: [], started: [] });
    expect(files).toEqual([]);
    expect(commands).toEqual([]);
  });
});

describe('relay verification and teardown', () => {
  it('verifies a mapping only when the live process matches port for port', async () => {
    const live = manager({ running: { 5173: 45_173 } });
    const drifted = manager({ running: { 5173: 46_000 } });
    const empty = manager();

    const mapping = [{ logicalPort: 5173, relayPort: 45_173, label: 'vite' }];
    await expect(verifyRelayMappings(live.options, mapping)).resolves.toBe(true);
    await expect(verifyRelayMappings(drifted.options, mapping)).resolves.toBe(false);
    await expect(verifyRelayMappings(empty.options, mapping)).resolves.toBe(false);
    // Nothing recorded is trivially consistent with nothing running.
    await expect(verifyRelayMappings(empty.options, [])).resolves.toBe(true);
  });

  it('treats an unreadable relay state as unverified, not as healthy', async () => {
    const { options } = manager({ running: { 5173: 45_173 }, statusExitCode: 1 });

    await expect(readRelayProcesses(options)).rejects.toBeInstanceOf(VercelRelayError);
    await expect(verifyRelayMappings(options, [{ logicalPort: 5173, relayPort: 45_173, label: 'vite' }]))
      .resolves.toBe(false);
  });

  it('stops named relays and every relay', async () => {
    const { options, commands, running } = manager({ running: { 5173: 45_173, 3000: 43_000 } });

    await stopRelays(options, [3000]);
    expect([...running.keys()]).toEqual([5173]);

    await stopAllRelays(options);
    expect([...running.keys()]).toEqual([]);
    expect(commands).toEqual([['stop', '3000'], ['stop-all']]);
  });

  it('does not call the Sandbox to stop nothing', async () => {
    const { options, commands } = manager();

    await stopRelays(options, []);

    expect(commands).toEqual([]);
  });
});
