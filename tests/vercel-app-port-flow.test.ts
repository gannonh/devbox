import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAppPorts, UNRESOLVED_CHECKOUT_REVISION } from '../src/providers/vercel/app-port-flow.js';
import { APP_PORT_DETECTOR_VERSION, detectAppPorts } from '../src/providers/vercel/app-ports.js';
import { createVercelBranchMetadataStore } from '../src/providers/vercel/metadata.js';
import type { VercelBranchMetadataStore } from '../src/providers/vercel/metadata.js';
import { DEVBOX_NOVNC_PROXY_PORT } from '../src/providers/vercel/ports.js';
import type {
  SandboxRoute,
  VercelCommandResult,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
} from '../src/providers/vercel/client.js';
import type { ProviderInput } from '../src/providers/types.js';

const REVISION = 'b'.repeat(40);
const US = '\u001f';
const RS = '\u001e';

/** The scanner's `path<US>contents<RS>` wire format. */
function emitted(files: Record<string, string>): string {
  return Object.entries(files).map(([path, content]) => `${path}${US}${content}${RS}`).join('');
}

const OTHER_REVISION = 'c'.repeat(40);
const VITE_PACKAGE = JSON.stringify({ scripts: { dev: 'vite' } });
const NEXT_PACKAGE = JSON.stringify({ dependencies: { next: '15.0.0' } });
const IDENTITY = {
  name: 'devbox-vercel-test',
  repository: 'github.com/acme/repo',
  branch: 'feature/ui',
  packageVersion: '0.1.2',
  tags: {
    provider: 'vercel',
    repository: 'github-com-acme-repo',
    branch: 'feature-ui-0123456789abcdef',
    version: 'v0-1-2',
    identity: 'identity-hash',
  },
} as const;

function routesFor(ports: readonly number[]): SandboxRoute[] {
  return [...ports].sort((left, right) => left - right).map((port) => ({
    port,
    subdomain: `devbox-${port}`,
    url: `https://devbox-${port}.vercel.run`,
  }));
}

const SANDBOX_ID = 'sbx-test';

/** Deterministic stand-in for the kernel's choice, so expectations stay legible. */
function relayPortFor(logicalPort: number): number {
  return 40_000 + logicalPort;
}

function fakeSandbox(ports: number[]) {
  const state = { ports: [...ports] };
  const handle = {
    id: SANDBOX_ID,
    name: 'devbox-vercel-test',
    status: 'running',
    cwd: '/vercel/sandbox',
    get routes(): readonly SandboxRoute[] {
      return routesFor(state.ports);
    },
    domain: (port: number) => `https://devbox-${port}.vercel.run`,
  } as unknown as VercelSandboxHandle;
  return { handle, state };
}

interface ClientOptions {
  /** Relays already running in the Sandbox, as `logicalPort -> relayPort`. */
  running?: Record<number, number>;
  packageJson?: string | null;
  /** Workspace member manifests keyed by path, e.g. `apps/web`. */
  members?: Record<string, string>;
  /** Contents of pnpm-workspace.yaml, the only declaration in many repos. */
  pnpmWorkspace?: string;
  revision?: string;
  packageJsonExitCode?: number;
  onUpdate?: (ports: readonly number[]) => void;
}

function fakeClient(state: { ports: number[] }, options: ClientOptions = {}) {
  const updates: number[][] = [];
  // Stands in for app-relay-control.sh: one live process per logical port,
  // each holding the listener the routes are supposed to name.
  const relays = new Map<number, number>(
    Object.entries(options.running ?? {}).map(([logical, relay]) => [Number(logical), relay]),
  );
  const relayCommands: string[][] = [];

  function relayControl(args: readonly string[]): string {
    relayCommands.push([...args]);
    const [command, ...rest] = args;
    if (command === 'status') {
      return [...relays].map(([logical, relay]) =>
        `{"logicalPort":${logical},"relayPort":${relay},"pid":${1000 + logical},"running":true}`).join('\n');
    }
    if (command === 'stop') {
      for (const port of rest) relays.delete(Number(port));
      return '';
    }
    if (command === 'stop-all') {
      relays.clear();
      return '';
    }
    const logical = Number(rest[0]);
    const preferred = rest[1] === '-' ? undefined : Number(rest[1]);
    const forbidden = new Set((rest[2] === '-' ? '' : rest[2] ?? '').split(',').filter(Boolean).map(Number));
    let chosen = preferred !== undefined && !forbidden.has(preferred) ? preferred : relayPortFor(logical);
    while (forbidden.has(chosen)) chosen += 1;
    relays.set(logical, chosen);
    return `{"logicalPort":${logical},"relayPort":${chosen},"pid":${1000 + logical}}`;
  }

  const client = {
    writeFiles: vi.fn(async () => {}),
    runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      if (request.cmd === 'bash' && (request.args ?? [])[0]?.endsWith('app-relay-control.sh')) {
        return {
          exitCode: 0,
          stdout: async () => `${relayControl((request.args ?? []).slice(1))}\n`,
        } as unknown as VercelCommandResult;
      }
      if (request.cmd === 'git') {
        return {
          exitCode: 0,
          stdout: async () => `${options.revision ?? REVISION}\n`,
        } as unknown as VercelCommandResult;
      }
      if ((request.args ?? []).join(' ').includes('for f in')) {
        return {
          exitCode: 0,
          stdout: async () => emitted(Object.fromEntries(
            Object.entries(options.members ?? {}).map(([path, content]) => [`./${path}/package.json`, content]),
          )),
        } as unknown as VercelCommandResult;
      }
      const content = options.packageJson === undefined ? VITE_PACKAGE : options.packageJson;
      return {
        exitCode: options.packageJsonExitCode ?? 0,
        stdout: async () => emitted({
          ...(content === null ? {} : { './package.json': content }),
          ...(options.pnpmWorkspace === undefined ? {} : { './pnpm-workspace.yaml': options.pnpmWorkspace }),
        }),
      } as unknown as VercelCommandResult;
    }),
    updatePorts: vi.fn(async (_sandbox: VercelSandboxHandle, ports: readonly number[]) => {
      updates.push([...ports]);
      options.onUpdate?.(ports);
      state.ports = [...ports];
    }),
  } as unknown as VercelSandboxClient & { updatePorts: ReturnType<typeof vi.fn> };
  return { client, updates, relays, relayCommands };
}

async function repoRoot(forwardPorts?: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devbox-app-port-flow-'));
  if (forwardPorts !== undefined) {
    await mkdir(join(root, '.devcontainer'), { recursive: true });
    await writeFile(
      join(root, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ forwardPorts }),
    );
  }
  return root;
}

async function branchStore(): Promise<VercelBranchMetadataStore> {
  const stateHome = await mkdtemp(join(tmpdir(), 'devbox-app-port-state-'));
  return createVercelBranchMetadataStore({
    stateHome,
    repoKey: 'github.com/acme/repo',
    branch: 'feature/ui',
  });
}

interface RunOptions {
  ports?: number[];
  forwardPorts?: unknown[];
  client?: ClientOptions;
  tty?: boolean;
  exposePorts?: number[];
  answers?: string[];
  store?: VercelBranchMetadataStore;
  secrets?: string[];
}

async function run(options: RunOptions = {}) {
  const { handle, state } = fakeSandbox(options.ports ?? [DEVBOX_NOVNC_PROXY_PORT]);
  const { client, updates, relays, relayCommands } = fakeClient(state, options.client ?? {});
  const store = options.store ?? await branchStore();
  const root = await repoRoot(options.forwardPorts);
  const chunks: string[] = [];
  const stderr = new PassThrough();
  stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const answers = [...(options.answers ?? [''])];
  const prompt = vi.fn(async () => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error('unexpected prompt');
    if (answer === 'n') return { decision: 'rejected' as const, selected: [] };
    if (answer.startsWith('e:')) {
      return {
        decision: 'edited' as const,
        selected: answer.slice(2).split(',').filter(Boolean).map(Number),
      };
    }
    return { decision: 'accepted' as const, selected: [] };
  });
  const promptSpy = vi.fn(async (promptOptions: Parameters<typeof prompt>[0] extends never
    ? never
    : { candidates: ReadonlyArray<{ port: number }>; configured: readonly number[]; conflicting: boolean }) => {
    const result = await prompt();
    return result.decision === 'accepted'
      ? { decision: 'accepted' as const, selected: promptOptions.candidates.map(({ port }) => port) }
      : result;
  });

  const result = await applyAppPorts({
    sandbox: handle,
    client,
    branchStore: store,
    repoRoot: root,
    workspace: '/vercel/sandbox/repo',
    branch: 'feature/ui',
    tty: options.tty ?? true,
    stdin: new PassThrough() as unknown as ProviderInput,
    stderr,
    ...(options.exposePorts === undefined ? {} : { exposePorts: options.exposePorts }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    prompt: promptSpy as never,
  });
  return {
    result,
    updates,
    state,
    store,
    client,
    relays,
    relayCommands,
    prompt: promptSpy,
    output: chunks.join(''),
    async metadata() {
      return store.read();
    },
  };
}

describe('zero-config app port flow', () => {
  it('publishes a relay for Vite 5173 and never exposes the app listener itself', async () => {
    const { result, updates, state, output, relays, ...harness } = await run();

    // 5173 is the app's port and stays private; the route names the relay.
    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)]]);
    expect(state.ports).toEqual([DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)]);
    expect(state.ports).not.toContain(5173);
    expect(relays.get(5173)).toBe(relayPortFor(5173));
    expect(result).toMatchObject({
      selected: [5173],
      updated: true,
      labels: { 5173: 'vite' },
      relays: [{ logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' }],
    });
    const metadata = await harness.metadata();
    expect(metadata?.appPorts).toEqual({
      sandboxId: SANDBOX_ID,
      selected: [5173],
      relays: [{ logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' }],
      applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      fingerprint: detectAppPorts([{ path: '.', content: VITE_PACKAGE }]).fingerprint,
      detectorVersion: APP_PORT_DETECTOR_VERSION,
      revision: REVISION,
    });
    expect(metadata?.pendingAppPorts).toBeUndefined();
    expect(output).not.toContain('scripts');
  });

  it('starts one relay per app port, never targeting a display port', async () => {
    const { relayCommands } = await run();

    const starts = relayCommands.filter(([command]) => command === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].slice(0, 2)).toEqual(['start', '5173']);
    // The forbidden list is what stops the kernel handing back 5173 itself, a
    // display port, or a port a sibling relay already holds.
    const forbidden = starts[0][3].split(',').map(Number);
    expect(forbidden).toContain(DEVBOX_NOVNC_PROXY_PORT);
    expect(forbidden).toContain(5900);
    expect(forbidden).toContain(6081);
  });

  it('finds the app in a monorepo whose root only runs a task runner', async () => {
    const { updates, result, output } = await run({
      client: {
        // The exact shape of a Turborepo: the root declares members only in
        // pnpm-workspace.yaml and its dev script just runs the task runner.
        packageJson: JSON.stringify({
          scripts: { dev: 'turbo dev' },
          devDependencies: { turbo: '^2.0.0' },
        }),
        pnpmWorkspace: 'packages:\n  - "apps/*"\n  - "packages/*"\n',
        members: {
          'apps/web': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^8' } }),
          'packages/ui': JSON.stringify({ name: 'ui' }),
        },
      },
    });

    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)]]);
    expect(result).toMatchObject({ selected: [5173], labels: { 5173: 'vite' } });
    // The workspace path is what tells the user which app the port belongs to.
    expect(output).not.toContain('no app ports were inferred');
  });

  it('names the workspaces it read when a monorepo yields nothing', async () => {
    const { output } = await run({
      client: {
        packageJson: JSON.stringify({ workspaces: ['packages/*'], scripts: { dev: 'turbo dev' } }),
        members: { 'packages/ui': JSON.stringify({ name: 'ui' }) },
      },
      tty: false,
      answers: [],
    });

    expect(output).toContain('scanned 1 workspace manifest(s): packages/ui');
  });

  it('detects Next 3000 and applies it the same way', async () => {
    const { result, updates } = await run({ client: { packageJson: NEXT_PACKAGE } });

    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(3000)]]);
    expect(result.labels).toEqual({ 3000: 'next' });
  });

  it('unions a configured app port with a detected one and keeps 6080 exactly once', async () => {
    const { updates } = await run({ forwardPorts: [4000, DEVBOX_NOVNC_PROXY_PORT] });

    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000), relayPortFor(5173)]]);
    expect(updates[0].filter((port) => port === DEVBOX_NOVNC_PROXY_PORT)).toHaveLength(1);
  });

  it('keeps configured ports when the candidates are rejected', async () => {
    const { updates, result } = await run({ forwardPorts: [4000], answers: ['n'] });

    expect(result.selected).toEqual([]);
    // The rejected candidate is gone; the trusted configured port is still
    // published, through its own relay.
    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000)]]);
  });

  it('keeps configured ports when the inferred set is edited', async () => {
    const { updates } = await run({ forwardPorts: [4000], answers: ['e:4321'] });

    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000), relayPortFor(4321)]]);
  });

  it('fails on an invalid configured port before any candidate can mask it', async () => {
    await expect(run({ forwardPorts: [5900] })).rejects.toThrow(/forbidden\/private/);
  });

  it('accepts the maximum port set and rejects one more before any update', async () => {
    const maximum = Array.from({ length: 12 }, (_value, index) => 4000 + index);
    const accepted = await run({ forwardPorts: maximum });

    // Relaying does not change the arithmetic: one app still costs one slot.
    expect(accepted.updates).toEqual([[
      DEVBOX_NOVNC_PROXY_PORT,
      ...maximum.map(relayPortFor),
      relayPortFor(5173),
    ]]);
    expect(accepted.updates[0]).toHaveLength(14);

    const overflow = Array.from({ length: 13 }, (_value, index) => 4000 + index);
    const notOffered = await run({ forwardPorts: overflow, answers: [] });

    expect(notOffered.prompt).not.toHaveBeenCalled();
    expect(notOffered.updates[0]).toHaveLength(14);
    expect(notOffered.output).toContain('not offering 5173');
    expect(notOffered.output).toContain('leave room for 0 more');
  });

  it('refuses an explicit --expose-ports request that cannot fit before any update', async () => {
    const overflow = Array.from({ length: 13 }, (_value, index) => 4000 + index);

    await expect(run({
      forwardPorts: overflow,
      exposePorts: [5173],
      tty: false,
    })).rejects.toThrow(/verified service maximum is 14.*at most 13 app ports/s);
  });

  it('still asks in a TTY when nothing is detected, so ports can be added by hand', async () => {
    const { updates, result, prompt } = await run({ client: { packageJson: null } });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toMatchObject({ candidates: [] });
    expect(updates).toEqual([]);
    expect(result.selected).toEqual([]);
  });

  it('exposes a hand-entered port when nothing was detected', async () => {
    const { updates } = await run({ client: { packageJson: null }, answers: ['e:4173'] });

    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4173)]]);
  });

  it('reports no inferred ports without failing outside a TTY', async () => {
    const { updates, output, result } = await run({
      client: { packageJson: null },
      tty: false,
      answers: [],
    });

    expect(updates).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(output).toContain('no app ports were inferred from the remote checkout');
    expect(output).toContain('--expose-ports <list>');
  });

  it('never exposes a new port outside a TTY and names the exact opt-in syntax', async () => {
    const { updates, output, prompt } = await run({ tty: false });

    expect(updates).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
    expect(output).toContain('skipped 5173 (vite default) because this run is not interactive');
    expect(output).toContain('devbox feature/ui --provider vercel --expose-ports 5173');
  });

  it('applies --expose-ports without prompting and adds it to the retained configured set', async () => {
    const { updates, prompt } = await run({
      tty: false,
      forwardPorts: [4000],
      exposePorts: [5173, 4173],
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(updates).toEqual([[
      DEVBOX_NOVNC_PROXY_PORT,
      relayPortFor(4000),
      relayPortFor(4173),
      relayPortFor(5173),
    ]]);
  });

  it('reuses a confirmed selection and its live relay without a route update', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      client: { running: { 5173: relayPortFor(5173) } },
      answers: [],
    });

    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.updates).toEqual([]);
    expect(second.relayCommands.some(([command]) => command === 'start')).toBe(false);
    expect(second.result).toMatchObject({ selected: [5173], updated: false });
    expect(second.output).toContain('reusing the confirmed selection 5173');
  });

  it('rebuilds the relay when the recorded process is gone, keeping its port', async () => {
    const first = await run();
    // A resumed Sandbox has the routes but none of the processes behind them.
    const second = await run({
      store: first.store,
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      answers: [],
    });

    expect(second.relayCommands.filter(([command]) => command === 'start')).toHaveLength(1);
    // Preferring the recorded port is what lets the printed URL survive.
    expect(second.relays.get(5173)).toBe(relayPortFor(5173));
    expect(second.updates).toEqual([]);
  });

  it('re-applies a confirmed selection when the Sandbox lost the route', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [DEVBOX_NOVNC_PROXY_PORT],
      client: { running: { 5173: relayPortFor(5173) } },
      answers: [],
    });

    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)]]);
  });

  it('prompts again in a TTY when the candidates change', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      client: {
        packageJson: JSON.stringify({ scripts: { dev: 'vite --port 4321' } }),
        running: { 5173: relayPortFor(5173) },
      },
      answers: [''],
    });

    expect(second.prompt).toHaveBeenCalledTimes(1);
    expect(second.updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4321)]]);
    // The relay for the port that is no longer selected is stopped last, after
    // the route that named it is gone.
    expect(second.relayCommands).toContainEqual(['stop', '5173']);
    expect(second.relays.has(5173)).toBe(false);
  });

  it('prompts again when only the checkout revision changed', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      client: { revision: OTHER_REVISION, running: { 5173: relayPortFor(5173) } },
      answers: [''],
    });

    expect(second.prompt).toHaveBeenCalledTimes(1);
  });

  it('notices changed candidates outside a TTY without exposing anything new', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      client: {
        packageJson: JSON.stringify({ scripts: { dev: 'vite --port 4321' } }),
        running: { 5173: relayPortFor(5173) },
      },
      tty: false,
      answers: [],
    });

    expect(second.updates).toEqual([]);
    expect(second.output).toContain('skipped 4321 (vite dev script)');
    expect(second.output).toContain('keeping the previously confirmed 5173');
  });

  it('leaves a pending record when the commit write fails and commits it on the next run', async () => {
    const store = await branchStore();
    await store.write({ identity: IDENTITY });
    const failing: VercelBranchMetadataStore = {
      ...store,
      write: vi.fn(async (input) => {
        if (input.appPorts !== undefined) throw new Error('metadata write failed');
        return store.write(input);
      }),
    };

    await expect(run({ store: failing })).rejects.toThrow('metadata write failed');
    const interrupted = await store.read();
    expect(interrupted?.pendingAppPorts).toMatchObject({
      sandboxId: SANDBOX_ID,
      previous: { relays: [], applied: [DEVBOX_NOVNC_PROXY_PORT] },
      desired: {
        relays: [{ logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' }],
        applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      },
      selected: [5173],
    });
    expect(interrupted?.appPorts).toBeUndefined();
    expect(interrupted?.identity).toEqual(IDENTITY);

    const recovered = await run({
      store,
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      client: { running: { 5173: relayPortFor(5173) } },
      answers: [],
    });

    expect(recovered.output).toContain('committing the interrupted route update');
    const metadata = await store.read();
    expect(metadata?.pendingAppPorts).toBeUndefined();
    expect(metadata?.appPorts).toMatchObject({
      selected: [5173],
      applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      relays: [{ logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' }],
    });
    expect(metadata?.identity).toEqual(IDENTITY);
  });

  it('records the committed previous route set when live routes are stale', async () => {
    const first = await run();
    const failing: VercelBranchMetadataStore = {
      ...first.store,
      write: vi.fn(async (input) => {
        if (input.pendingAppPorts === undefined) throw new Error('metadata commit failed');
        return first.store.write(input);
      }),
    };

    await expect(run({
      store: failing,
      forwardPorts: [4000],
      ports: [DEVBOX_NOVNC_PROXY_PORT, 9999],
      client: { running: { 5173: relayPortFor(5173) } },
      exposePorts: [],
    })).rejects.toThrow('metadata commit failed');

    expect((await first.store.read())?.pendingAppPorts).toMatchObject({
      previous: {
        relays: [{ logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' }],
        applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      },
    });

    const recovered = await run({
      store: first.store,
      forwardPorts: [4000],
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000)],
      client: { running: { 4000: relayPortFor(4000) } },
      tty: false,
      answers: [],
    });
    expect(recovered.relays.has(5173)).toBe(false);
    expect(recovered.relayCommands).toContainEqual(['stop', '5173']);
  });

  it('clears a pending record that never reached the Sandbox', async () => {
    const store = await branchStore();
    await store.write({
      pendingAppPorts: {
        sandboxId: SANDBOX_ID,
        previous: { relays: [], applied: [DEVBOX_NOVNC_PROXY_PORT] },
        desired: {
          relays: [{ logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' }],
          applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
        },
        selected: [5173],
        fingerprint: detectAppPorts([{ path: '.', content: VITE_PACKAGE }]).fingerprint,
        detectorVersion: APP_PORT_DETECTOR_VERSION,
        revision: REVISION,
      },
    });

    const { output, updates } = await run({
      store,
      ports: [DEVBOX_NOVNC_PROXY_PORT],
      client: { packageJson: null },
      tty: false,
      answers: [],
    });

    expect(output).toContain('clearing an interrupted route update that never applied');
    expect(updates).toEqual([]);
    expect((await store.read())?.pendingAppPorts).toBeUndefined();
  });

  it('restores the previous set when the actual routes match neither record', async () => {
    const store = await branchStore();
    const previousRelays = [{ logicalPort: 4000, relayPort: relayPortFor(4000), label: 'configured' }];
    await store.write({
      pendingAppPorts: {
        sandboxId: SANDBOX_ID,
        previous: { relays: previousRelays, applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000)] },
        desired: {
          relays: [
            ...previousRelays,
            { logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' },
          ],
          applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000), relayPortFor(5173)],
        },
        selected: [5173],
        fingerprint: detectAppPorts([{ path: '.', content: VITE_PACKAGE }]).fingerprint,
        detectorVersion: APP_PORT_DETECTOR_VERSION,
        revision: REVISION,
      },
    });

    const { output, updates } = await run({
      store,
      forwardPorts: [4000],
      ports: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000), 9999],
      client: { packageJson: null, running: { 4000: relayPortFor(4000) } },
      tty: false,
      answers: [],
    });

    expect(output).toContain(`restoring 6080, ${relayPortFor(4000)} after an interrupted route update`);
    expect(updates[0]).toEqual([DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000)]);
    const metadata = await store.read();
    expect(metadata?.pendingAppPorts).toBeUndefined();
    // The unknown 9999 route is gone and nothing was committed from the
    // interrupted update: the run continues from the restored configured set.
    expect(metadata?.appPorts).toMatchObject({
      selected: [],
      applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000)],
    });
  });

  it('retains pending and continues when the route update itself fails', async () => {
    const store = await branchStore();
    const fingerprint = detectAppPorts([{ path: '.', content: VITE_PACKAGE }]).fingerprint;
    const { result, updates, output, ...harness } = await run({
      store,
      client: {
        onUpdate: () => {
          throw new Error('sandbox update rejected');
        },
      },
    });

    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)]]);
    expect(result).toMatchObject({
      selected: [],
      applied: [DEVBOX_NOVNC_PROXY_PORT],
      updated: false,
    });
    expect(output).toContain('route update failed');
    expect(output).toContain('pending retained');
    const metadata = await harness.metadata();
    expect(metadata?.pendingAppPorts).toEqual({
      sandboxId: SANDBOX_ID,
      previous: { relays: [], applied: [DEVBOX_NOVNC_PROXY_PORT] },
      desired: {
        relays: [{ logicalPort: 5173, relayPort: relayPortFor(5173), label: 'vite' }],
        applied: [DEVBOX_NOVNC_PROXY_PORT, relayPortFor(5173)],
      },
      selected: [5173],
      fingerprint,
      detectorVersion: APP_PORT_DETECTOR_VERSION,
      revision: REVISION,
    });
    expect(metadata?.appPorts).toBeUndefined();
  });

  it('still publishes configured and --expose-ports without prompting when the checkout revision cannot be read', async () => {
    const { updates, result, output, prompt, ...harness } = await run({
      client: { revision: 'not-a-sha' },
      forwardPorts: [4000],
      exposePorts: [5173],
      tty: true,
    });

    // Inference is skipped; trusted host config and the explicit opt-in still
    // get relays. The all-zero sentinel is what metadata records instead of a
    // real SHA, so a later successful rev-parse will not silently reuse this.
    expect(updates).toEqual([[
      DEVBOX_NOVNC_PROXY_PORT,
      relayPortFor(4000),
      relayPortFor(5173),
    ]]);
    expect(result.selected).toEqual([5173]);
    expect(prompt).not.toHaveBeenCalled();
    expect(output).not.toContain('--expose-ports was not applied');
    const metadata = await harness.metadata();
    expect(metadata?.appPorts?.revision).toBe(UNRESOLVED_CHECKOUT_REVISION);
  });

  it('does not prompt when an unresolved checkout has only configured ports', async () => {
    const { updates, result, prompt, output } = await run({
      client: { revision: 'not-a-sha' },
      forwardPorts: [4000],
      tty: true,
      answers: [],
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(updates).toEqual([[DEVBOX_NOVNC_PROXY_PORT, relayPortFor(4000)]]);
    expect(result.selected).toEqual([]);
    expect(output).toContain('remote checkout revision could not be resolved');
  });

  it('keeps secrets out of scan failure notices', async () => {
    const store = await branchStore();
    const { handle, state } = fakeSandbox([DEVBOX_NOVNC_PROXY_PORT]);
    const client = {
      runCommand: vi.fn(async () => {
        throw new Error('transport failed with token vercel-secret');
      }),
      updatePorts: vi.fn(),
    } as unknown as VercelSandboxClient;
    const chunks: string[] = [];
    const stderr = new PassThrough();
    stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    await applyAppPorts({
      sandbox: handle,
      client,
      branchStore: store,
      repoRoot: await repoRoot(),
      workspace: '/vercel/sandbox/repo',
      branch: 'feature/ui',
      tty: false,
      stdin: new PassThrough() as unknown as ProviderInput,
      stderr,
      secrets: ['vercel-secret'],
    });

    expect(chunks.join('')).toContain('[REDACTED]');
    expect(chunks.join('')).not.toContain('vercel-secret');
    expect(state.ports).toEqual([DEVBOX_NOVNC_PROXY_PORT]);
  });
});
