import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAppPorts } from '../src/providers/vercel/app-port-flow.js';
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

function fakeSandbox(ports: number[]) {
  const state = { ports: [...ports] };
  const handle = {
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
  packageJson?: string | null;
  revision?: string;
  packageJsonExitCode?: number;
  onUpdate?: (ports: readonly number[]) => void;
}

function fakeClient(state: { ports: number[] }, options: ClientOptions = {}) {
  const updates: number[][] = [];
  const client = {
    runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      if (request.cmd === 'git') {
        return {
          exitCode: 0,
          stdout: async () => `${options.revision ?? REVISION}\n`,
        } as unknown as VercelCommandResult;
      }
      const content = options.packageJson === undefined ? VITE_PACKAGE : options.packageJson;
      if (content === null) return { exitCode: 42, stdout: async () => '' } as unknown as VercelCommandResult;
      return {
        exitCode: options.packageJsonExitCode ?? 0,
        stdout: async () => content,
      } as unknown as VercelCommandResult;
    }),
    updatePorts: vi.fn(async (_sandbox: VercelSandboxHandle, ports: readonly number[]) => {
      updates.push([...ports]);
      options.onUpdate?.(ports);
      state.ports = [...ports];
    }),
  } as unknown as VercelSandboxClient & { updatePorts: ReturnType<typeof vi.fn> };
  return { client, updates };
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
  const { client, updates } = fakeClient(state, options.client ?? {});
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
    prompt: promptSpy,
    output: chunks.join(''),
    async metadata() {
      return store.read();
    },
  };
}

describe('zero-config app port flow', () => {
  it('detects Vite 5173, applies it through a port update, and records the selection', async () => {
    const { result, updates, state, output, ...harness } = await run();

    expect(updates).toEqual([[5173, DEVBOX_NOVNC_PROXY_PORT]]);
    expect(state.ports).toEqual([5173, DEVBOX_NOVNC_PROXY_PORT]);
    expect(result).toMatchObject({ selected: [5173], updated: true, labels: { 5173: 'vite' } });
    const metadata = await harness.metadata();
    expect(metadata?.appPorts).toEqual({
      selected: [5173],
      applied: [5173, DEVBOX_NOVNC_PROXY_PORT],
      fingerprint: detectAppPorts(VITE_PACKAGE).fingerprint,
      detectorVersion: APP_PORT_DETECTOR_VERSION,
      revision: REVISION,
    });
    expect(metadata?.pendingAppPorts).toBeUndefined();
    expect(output).not.toContain('scripts');
  });

  it('detects Next 3000 and applies it the same way', async () => {
    const { result, updates } = await run({ client: { packageJson: NEXT_PACKAGE } });

    expect(updates).toEqual([[3000, DEVBOX_NOVNC_PROXY_PORT]]);
    expect(result.labels).toEqual({ 3000: 'next' });
  });

  it('unions a configured app port with a detected one and keeps 6080 exactly once', async () => {
    const { updates } = await run({
      forwardPorts: [4000, DEVBOX_NOVNC_PROXY_PORT],
      ports: [4000, DEVBOX_NOVNC_PROXY_PORT],
    });

    expect(updates).toEqual([[4000, 5173, DEVBOX_NOVNC_PROXY_PORT]]);
    expect(updates[0].filter((port) => port === DEVBOX_NOVNC_PROXY_PORT)).toHaveLength(1);
  });

  it('keeps configured ports when the candidates are rejected', async () => {
    const { updates, result } = await run({
      forwardPorts: [4000],
      ports: [4000, DEVBOX_NOVNC_PROXY_PORT],
      answers: ['n'],
    });

    expect(result.selected).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('keeps configured ports when the inferred set is edited', async () => {
    const { updates } = await run({
      forwardPorts: [4000],
      ports: [4000, DEVBOX_NOVNC_PROXY_PORT],
      answers: ['e:4321'],
    });

    expect(updates).toEqual([[4000, 4321, DEVBOX_NOVNC_PROXY_PORT]]);
  });

  it('fails on an invalid configured port before any candidate can mask it', async () => {
    await expect(run({ forwardPorts: [5900] })).rejects.toThrow(/forbidden\/private/);
  });

  it('accepts the maximum port set and rejects one more before any update', async () => {
    const maximum = Array.from({ length: 12 }, (_value, index) => 4000 + index);
    const accepted = await run({
      forwardPorts: maximum,
      ports: [...maximum, DEVBOX_NOVNC_PROXY_PORT],
    });

    expect(accepted.updates).toEqual([[...maximum, 5173, DEVBOX_NOVNC_PROXY_PORT]]);
    expect(accepted.updates[0]).toHaveLength(14);

    const overflow = Array.from({ length: 13 }, (_value, index) => 4000 + index);
    const notOffered = await run({
      forwardPorts: overflow,
      ports: [...overflow, DEVBOX_NOVNC_PROXY_PORT],
      answers: [],
    });

    expect(notOffered.prompt).not.toHaveBeenCalled();
    expect(notOffered.updates).toEqual([]);
    expect(notOffered.output).toContain('not offering 5173');
    expect(notOffered.output).toContain('leave room for 0 more');
  });

  it('refuses an explicit --expose-ports request that cannot fit before any update', async () => {
    const overflow = Array.from({ length: 13 }, (_value, index) => 4000 + index);

    await expect(run({
      forwardPorts: overflow,
      ports: [...overflow, DEVBOX_NOVNC_PROXY_PORT],
      exposePorts: [5173],
      tty: false,
    })).rejects.toThrow(/verified service maximum is 14.*at most 13 app ports/s);
  });

  it('reports no inferred ports without failing when nothing is detected', async () => {
    const { updates, output, result } = await run({ client: { packageJson: null } });

    expect(updates).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(output).toContain('no app ports were inferred');
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
      ports: [4000, DEVBOX_NOVNC_PROXY_PORT],
      exposePorts: [5173, 4173],
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(updates).toEqual([[4000, 4173, 5173, DEVBOX_NOVNC_PROXY_PORT]]);
  });

  it('reuses a confirmed selection on resume without prompting', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [5173, DEVBOX_NOVNC_PROXY_PORT],
      answers: [],
    });

    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.updates).toEqual([]);
    expect(second.result).toMatchObject({ selected: [5173], updated: false });
    expect(second.output).toContain('reusing the confirmed selection 5173');
  });

  it('re-applies a confirmed selection when the Sandbox lost the route', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [DEVBOX_NOVNC_PROXY_PORT],
      answers: [],
    });

    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.updates).toEqual([[5173, DEVBOX_NOVNC_PROXY_PORT]]);
  });

  it('prompts again in a TTY when the candidates change', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [5173, DEVBOX_NOVNC_PROXY_PORT],
      client: { packageJson: JSON.stringify({ scripts: { dev: 'vite --port 4321' } }) },
      answers: [''],
    });

    expect(second.prompt).toHaveBeenCalledTimes(1);
    expect(second.updates).toEqual([[4321, DEVBOX_NOVNC_PROXY_PORT]]);
  });

  it('prompts again when only the checkout revision changed', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [5173, DEVBOX_NOVNC_PROXY_PORT],
      client: { revision: OTHER_REVISION },
      answers: [''],
    });

    expect(second.prompt).toHaveBeenCalledTimes(1);
  });

  it('notices changed candidates outside a TTY without exposing anything new', async () => {
    const first = await run();
    const second = await run({
      store: first.store,
      ports: [5173, DEVBOX_NOVNC_PROXY_PORT],
      client: { packageJson: JSON.stringify({ scripts: { dev: 'vite --port 4321' } }) },
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
      previous: [DEVBOX_NOVNC_PROXY_PORT],
      desired: [5173, DEVBOX_NOVNC_PROXY_PORT],
      selected: [5173],
    });
    expect(interrupted?.appPorts).toBeUndefined();
    expect(interrupted?.identity).toEqual(IDENTITY);

    const recovered = await run({ store, ports: [5173, DEVBOX_NOVNC_PROXY_PORT], answers: [] });

    expect(recovered.output).toContain('committing the interrupted route update');
    const metadata = await store.read();
    expect(metadata?.pendingAppPorts).toBeUndefined();
    expect(metadata?.appPorts).toMatchObject({ selected: [5173], applied: [5173, DEVBOX_NOVNC_PROXY_PORT] });
    expect(metadata?.identity).toEqual(IDENTITY);
  });

  it('clears a pending record that never reached the Sandbox', async () => {
    const store = await branchStore();
    await store.write({
      pendingAppPorts: {
        previous: [DEVBOX_NOVNC_PROXY_PORT],
        desired: [5173, DEVBOX_NOVNC_PROXY_PORT],
        selected: [5173],
        fingerprint: detectAppPorts(VITE_PACKAGE).fingerprint,
        detectorVersion: APP_PORT_DETECTOR_VERSION,
        revision: REVISION,
      },
    });

    const { output, updates } = await run({
      store,
      ports: [DEVBOX_NOVNC_PROXY_PORT],
      client: { packageJson: null },
      answers: [],
    });

    expect(output).toContain('clearing an interrupted route update that never applied');
    expect(updates).toEqual([]);
    expect((await store.read())?.pendingAppPorts).toBeUndefined();
  });

  it('restores the previous set when the actual routes match neither record', async () => {
    const store = await branchStore();
    await store.write({
      pendingAppPorts: {
        previous: [4000, DEVBOX_NOVNC_PROXY_PORT],
        desired: [4000, 5173, DEVBOX_NOVNC_PROXY_PORT],
        selected: [5173],
        fingerprint: detectAppPorts(VITE_PACKAGE).fingerprint,
        detectorVersion: APP_PORT_DETECTOR_VERSION,
        revision: REVISION,
      },
    });

    const { output, updates } = await run({
      store,
      forwardPorts: [4000],
      ports: [4000, 9999, DEVBOX_NOVNC_PROXY_PORT],
      client: { packageJson: null },
      answers: [],
    });

    expect(output).toContain('restoring 4000, 6080 after an interrupted route update');
    expect(updates[0]).toEqual([4000, DEVBOX_NOVNC_PROXY_PORT]);
    const metadata = await store.read();
    expect(metadata?.pendingAppPorts).toBeUndefined();
    // The unknown 9999 route is gone and nothing was committed from the
    // interrupted update: the run continues from the restored configured set.
    expect(metadata?.appPorts).toMatchObject({ selected: [], applied: [4000, DEVBOX_NOVNC_PROXY_PORT] });
  });

  it('reconciles and rethrows when the route update itself fails', async () => {
    const store = await branchStore();
    const failing = run({
      store,
      client: {
        onUpdate: () => {
          throw new Error('sandbox update rejected');
        },
      },
    });

    await expect(failing).rejects.toThrow('sandbox update rejected');
    const metadata = await store.read();
    expect(metadata?.pendingAppPorts).toBeUndefined();
    expect(metadata?.appPorts).toBeUndefined();
  });

  it('does not expose anything when the checkout revision cannot be read', async () => {
    const { updates, output } = await run({
      client: { revision: 'not-a-sha' },
      exposePorts: [5173],
      tty: false,
    });

    expect(updates).toEqual([]);
    expect(output).toContain('--expose-ports was not applied');
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
