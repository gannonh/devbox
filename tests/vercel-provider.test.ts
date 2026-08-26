import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { access, chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dispatch } from '../src/cli.js';
import { createVercelProvider } from '../src/providers/vercel/provider.js';
import type { DevboxProvider, ProviderBranchRequest } from '../src/providers/types.js';
import type { ShellRunner } from '../src/lib/shell.js';
import type { VercelLifecycle, VercelLifecycleOptions } from '../src/providers/vercel/lifecycle.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import {
  createVercelBranchMetadataStore,
  createVercelScopeMetadataStore,
} from '../src/providers/vercel/metadata.js';
import type { VercelTerminalAdapter } from '../src/providers/vercel/terminal.js';
import type { VercelSandboxClient, VercelSandboxHandle } from '../src/providers/vercel/client.js';
import { DISPLAY_STATUS_OUTPUT } from './vercel-display-status.fixture.js';
import { resolveTestImage, TEST_IMAGE_REFERENCE } from './vercel-image.fixture.js';

const DISPLAY_TOKEN = 'test-novnc-token-aaaaaaaaaaaaaaaaaaaa';

function request(overrides: Partial<ProviderBranchRequest> = {}): ProviderBranchRequest {
  const defaults: ProviderBranchRequest = {
    repoRoot: '/repo',
    repoName: 'repo',
    env: {
      HOME: '/tmp/devbox-vercel-provider-no-pi',
      GH_TOKEN: 'github-secret',
      VERCEL_TOKEN: 'vercel-secret',
      VERCEL_TEAM_ID: 'team-1',
      VERCEL_PROJECT_ID: 'project-1',
    },
    tty: true,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    branch: 'feature/ui',
  };
  const env = overrides.env ?? defaults.env;
  return {
    ...defaults,
    ...overrides,
    env: { ...env, HOME: env.HOME ?? defaults.env.HOME },
  };
}

function runner(): ShellRunner {
  return {
    exec: vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'remote') return 'git@github.com:Acme/Repo.git';
      if (args[0] === 'ls-remote' && args.includes('--symref')) return 'ref: refs/heads/main\tHEAD\n';
      throw new Error(`unexpected exec: ${args.join(' ')}`);
    }),
    execQuiet: vi.fn(async () => ({ stdout: 'abc\trefs/heads/feature/ui\n', code: 0 })),
    spawnInherit: vi.fn(),
  };
}

function sandbox(): VercelSandboxHandle {
  return {
    id: 'sandbox-id',
    name: 'devbox-vercel-test',
    status: 'running',
    cwd: '/vercel/sandbox',
    tags: {},
    openInteractive: vi.fn(),
    extendTimeout: vi.fn(),
    listSessions: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    writeFiles: vi.fn(async () => {}),
    runCommand: vi.fn(async (command: { cmd?: string }) => command.cmd === '/usr/local/bin/devbox-status'
      ? { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT }
      : { exitCode: 0 }),
    domain: vi.fn((port: number) => `https://sandbox.example/${port}`),
  } as unknown as VercelSandboxHandle;
}

function lifecycle(): VercelLifecycle {
  return {
    up: vi.fn(async () => sandbox()),
    get: vi.fn(),
    attach: vi.fn(),
    list: vi.fn(),
    routes: vi.fn(),
    url: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
  } as unknown as VercelLifecycle;
}

async function seedBranchMetadata(stateHome: string, branch = 'feature/ui'): Promise<void> {
  await createVercelBranchMetadataStore({
    stateHome,
    repoKey: 'github.com/acme/repo',
    branch,
  }).write({
    displayCredentials: { username: 'devbox', password: DISPLAY_TOKEN },
  });
}

/**
 * Stand-in for app-relay-control.sh: reports live relays and starts new ones
 * on a deterministic port so route expectations stay readable.
 */
function relayControlResponse(args: readonly string[], running: Record<number, number>): string {
  const [command, ...rest] = args;
  if (command === 'status') {
    return Object.entries(running)
      .map(([logical, relay]) =>
        `{"logicalPort":${logical},"relayPort":${relay},"pid":${1000 + Number(logical)},"running":true}`)
      .join('\n');
  }
  if (command === 'start') {
    const logical = Number(rest[0]);
    return `{"logicalPort":${logical},"relayPort":${40_000 + logical},"pid":${1000 + logical}}`;
  }
  return '';
}

function isRelayControl(request: { cmd?: string; args?: string[] }): boolean {
  return request.cmd === 'bash' && (request.args?.[0] ?? '').endsWith('app-relay-control.sh');
}

describe('Vercel provider', () => {
  it('uses production device auth defaults to render and optionally open the verification URL', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-provider-device-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'device-team',
      projectId: 'device-project',
    }));
    const deviceRequest = {
      device_code: 'device-secret-code',
      user_code: 'SAFE-CODE',
      interval: 0,
      verification_uri: 'https://vercel.com/device',
      verification_uri_complete: 'https://vercel.com/device?user_code=SAFE-CODE',
      expiresAt: Date.now() + 60_000,
    };
    const OAuth = vi.fn().mockResolvedValue({
      deviceAuthorizationRequest: vi.fn().mockResolvedValue(deviceRequest),
    });
    const pollForToken = vi.fn(() => (async function* () {})());
    const getAuth = vi.fn().mockReturnValue({ token: 'device-vercel-token' });
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-device-auth-state-'));
    await seedBranchMetadata(stateHome);
    const lifecycleInstance = lifecycle();
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'exited' as const, code: 0 })),
    };
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });
    const opener = vi.fn();
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      lifecycle: (options) => {
        expect(options.credentials).toEqual({
          token: 'device-vercel-token',
          teamId: 'device-team',
          projectId: 'device-project',
        });
        return lifecycleInstance;
      },
      terminal,
      opener,
      stateHome,
      confirmation: vi.fn(async () => true),
      credentialOptions: { deviceAuthPrimitives: { OAuth, pollForToken, getAuth } },
    });

    await expect(provider.up(request({
      repoRoot,
      env: { GH_TOKEN: 'github-secret' },
      stderr,
    }))).resolves.toEqual({ exitCode: 0 });

    expect(output).toContain(deviceRequest.verification_uri_complete);
    expect(output).toContain(deviceRequest.user_code);
    expect(output).not.toContain(deviceRequest.device_code);
    expect(opener).toHaveBeenCalledWith(deviceRequest.verification_uri_complete);
    expect(OAuth).toHaveBeenCalledOnce();
    expect(pollForToken).toHaveBeenCalledOnce();
    expect(getAuth).toHaveBeenCalledOnce();
  });

  it('keeps independent branch records while sharing one confirmed repository scope', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-branches-'));
    const remote = 'github.com/acme/repo';
    const env = {
      GH_TOKEN: 'github-secret',
      VERCEL_TOKEN: 'vercel-secret',
      VERCEL_TEAM_ID: 'team-1',
      VERCEL_PROJECT_ID: 'project-1',
    };
    const shell: ShellRunner = {
      exec: vi.fn(async (_command, args) => {
        if (args[0] === 'remote') return 'git@github.com:Acme/Repo.git';
        if (args[0] === 'ls-remote' && args.includes('--symref')) return 'ref: refs/heads/main\tHEAD\n';
        throw new Error(`unexpected exec: ${args.join(' ')}`);
      }),
      execQuiet: vi.fn(async (_command, args) => ({
        stdout: `sha\t${args.at(-1)}\n`,
        code: 0,
      })),
      spawnInherit: vi.fn(),
    };
    const lifecycleByBranch = new Map<string, VercelLifecycle>();
    const factory = (options: VercelLifecycleOptions): VercelLifecycle => {
      const branch = options.branch ?? 'list';
      const identity = createVercelIdentity({
        remote,
        branch,
        scope: { teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID },
      });
      const handle = sandbox();
      Object.defineProperty(handle, 'name', { value: identity.name });
      Object.defineProperty(handle, 'tags', { value: { ...identity.tags } });
      const instance = {
        up: vi.fn(async () => {
          await options.branchMetadataStore!.write({
            identity: {
              name: identity.name,
              repository: identity.canonicalRepository,
              branch: identity.branch,
              packageVersion: identity.packageVersion,
              tags: {
                provider: identity.tags.provider,
                repository: identity.tags.repository,
                branch: identity.tags.branch,
                version: identity.tags.version,
                identity: identity.tags.identity,
              },
            },
            configuration: {
              imageReference: TEST_IMAGE_REFERENCE,
              sourceUrl: 'https://github.com/acme/repo.git',
              sourceRevision: 'main',
              requestedBranch: identity.branch,
              needsBranchSetup: false,
              persistent: true,
              keepLastSnapshots: 1,
              timeoutMs: 1_800_000,
            },
          });
          return handle;
        }),
        get: vi.fn(),
        attach: vi.fn(async () => handle),
        list: vi.fn(async () => [...lifecycleByBranch.values()].map((entry) => {
          const value = entry as unknown as { identity: typeof identity };
          return {
            name: value.identity.name,
            status: 'running',
            tags: { ...value.identity.tags },
          };
        })),
        routes: vi.fn(async () => []),
        url: vi.fn(),
        stop: vi.fn(async () => ({ name: identity.name, sessions: [] })),
        remove: vi.fn(async () => {
          await options.branchMetadataStore!.remove();
          return {
            verified: true,
            sandboxDeleted: true,
            snapshotsCleaned: true,
            sandboxMissing: false,
            snapshotIds: [],
            residualSandboxIds: [],
            residualSnapshotIds: [],
            finalSessions: [],
            errors: [],
          };
        }),
        identity,
      } as unknown as VercelLifecycle & { identity: typeof identity };
      lifecycleByBranch.set(branch, instance);
      return instance;
    };
    const confirmation = vi.fn(async () => true);
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: shell,
      stateHome,
      lifecycle: factory,
      confirmation,
      terminal: { attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })) },
    });

    await provider.up(request({ branch: 'feature/a', env }));
    await provider.up(request({ branch: 'feature/b', env }));
    expect(confirmation).toHaveBeenCalledOnce();

    const feature = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/a' });
    const release = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/b' });
    await expect(feature.read()).resolves.toMatchObject({ identity: { branch: 'feature/a' } });
    await expect(release.read()).resolves.toMatchObject({ identity: { branch: 'feature/b' } });

    await expect(provider.attach(request({ branch: 'feature/a', env }))).resolves.toEqual({ exitCode: 0 });
    await expect(provider.attach(request({ branch: 'feature/b', env }))).resolves.toEqual({ exitCode: 0 });
    await expect(provider.stop(request({ branch: 'feature/a', env, tty: false }))).resolves.toEqual({ exitCode: 0 });
    const malformedMain = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'main' });
    await malformedMain.write({});
    await writeFile(malformedMain.path, '{not-json');
    const listStderr = new PassThrough();
    let listOutput = '';
    listStderr.on('data', (chunk) => { listOutput += chunk.toString(); });
    await expect(provider.list(request({ env, stderr: listStderr }))).resolves.toEqual({ exitCode: 0 });
    const featureIdentity = (lifecycleByBranch.get('feature/a') as unknown as { identity: ReturnType<typeof createVercelIdentity> }).identity;
    const releaseIdentity = (lifecycleByBranch.get('feature/b') as unknown as { identity: ReturnType<typeof createVercelIdentity> }).identity;
    expect(listOutput).toContain(`identity=${featureIdentity.tags.identity}`);
    expect(listOutput).toContain(`identity=${releaseIdentity.tags.identity}`);
    await expect(provider.remove(request({ branch: 'feature/a', env, tty: false }))).resolves.toEqual({ exitCode: 0 });
    await expect(feature.read()).resolves.toBeNull();
    await expect(release.read()).resolves.toMatchObject({ identity: { branch: 'feature/b' } });
    expect(shell.execQuiet).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['origin']),
      expect.anything(),
    );
  });

  it('lists by repository scope without reading or locking synthetic main metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-list-scope-'));
    const remote = 'github.com/acme/repo';
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    await scope.write({ teamId: 'team-1', projectId: 'project-1' });
    const main = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'main' });
    const mainLock = await main.acquireLock();
    const identity = createVercelIdentity({
      remote,
      branch: 'feature/ui',
      scope: { teamId: 'team-1', projectId: 'project-1' },
    });
    let resolveListed!: () => void;
    const listed = new Promise<void>((resolve) => { resolveListed = resolve; });
    const client = {
      listSandboxes: vi.fn(async () => {
        resolveListed();
        return [{ name: identity.name, status: 'running' as const, persistent: true, tags: { ...identity.tags } }];
      }),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      client,
    });

    const listing = provider.list(request({ env: { VERCEL_TOKEN: 'vercel-secret' } }));
    let listTimeout!: ReturnType<typeof setTimeout>;
    const listedWhileMainLocked = await Promise.race([
      listed.then(() => true),
      new Promise<boolean>((resolve) => {
        listTimeout = setTimeout(() => resolve(false), 500);
      }),
    ]);
    clearTimeout(listTimeout);
    await mainLock.release();
    await expect(listing).resolves.toEqual({ exitCode: 0 });

    expect(listedWhileMainLocked).toBe(true);
    await expect(access(main.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(client.listSandboxes).toHaveBeenCalledWith({
      credentials: { token: 'vercel-secret', teamId: 'team-1', projectId: 'project-1' },
      tags: { provider: 'vercel', repository: identity.tags.repository },
    });
  });

  it('prompts once when concurrent first-use up calls share a repository scope lock', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-concurrent-'));
    await seedBranchMetadata(stateHome, 'feature/one');
    await seedBranchMetadata(stateHome, 'feature/two');
    const entered = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const currentLifecycle = lifecycle();
    currentLifecycle.up = vi.fn(async () => {
      entered();
      await gate;
      return sandbox();
    });
    const confirmation = vi.fn(async () => true);
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      confirmation,
      terminal: { attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })) },
    });
    const first = provider.up(request({ branch: 'feature/one' }));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const second = provider.up(request({ branch: 'feature/two' }));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
    expect(confirmation).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { exitCode: 0 },
      { exitCode: 0 },
    ]);
    expect(confirmation).toHaveBeenCalledOnce();
    expect(currentLifecycle.up).toHaveBeenCalledTimes(2);
  });

  it('releases the scope lock before a first terminal remains open', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-terminal-lock-'));
    await seedBranchMetadata(stateHome, 'feature/one');
    await seedBranchMetadata(stateHome, 'feature/two');
    const terminalEntered = vi.fn();
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let secondLifecycleStarted = false;
    let resolveSecondLifecycle!: () => void;
    const secondLifecycle = new Promise<void>((resolve) => { resolveSecondLifecycle = resolve; });
    let lifecycleUpCalls = 0;
    const currentLifecycle = lifecycle();
    currentLifecycle.up = vi.fn(async () => {
      lifecycleUpCalls += 1;
      if (lifecycleUpCalls === 2) {
        secondLifecycleStarted = true;
        resolveSecondLifecycle();
      }
      return sandbox();
    });
    let terminalCalls = 0;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => {
        terminalCalls += 1;
        if (terminalCalls === 1) {
          terminalEntered();
          await terminalGate;
        }
        return { status: 'detached' as const, reason: 'escape' as const };
      }),
    };
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      confirmation: vi.fn(async () => true),
      terminal,
    });

    const first = provider.up(request({ branch: 'feature/one' }));
    await vi.waitFor(() => expect(terminalEntered).toHaveBeenCalledOnce());
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: 'github.com/acme/repo' });
    await expect(scope.read()).resolves.toEqual({
      schemaVersion: 2,
      metadataKind: 'scope',
      provider: 'vercel',
      repoKeyHash: expect.any(String),
      teamId: 'team-1',
      projectId: 'project-1',
    });

    const second = provider.up(request({ branch: 'feature/two' }));
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const secondStarted = await Promise.race([
      secondLifecycle.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), 500);
      }),
    ]);
    clearTimeout(timeoutHandle);
    releaseTerminal();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { exitCode: 0 },
      { exitCode: 0 },
    ]);
    expect(secondStarted).toBe(true);
    expect(secondLifecycleStarted).toBe(true);
  });

  it('releases the repository scope lock before a slow real lifecycle create', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-slow-create-'));
    const firstCreateStarted = vi.fn();
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let resolveSecondCreate!: () => void;
    const secondCreate = new Promise<void>((resolve) => { resolveSecondCreate = resolve; });
    let createCalls = 0;
    const client = {
      getOrCreate: vi.fn(async (createRequest: { name: string; tags: Record<string, string>; onCreate?: (handle: VercelSandboxHandle) => Promise<void> }) => {
        createCalls += 1;
        if (createCalls === 1) {
          firstCreateStarted();
          await createGate;
        } else if (createCalls === 2) {
          resolveSecondCreate();
        }
        const handle = {
          ...sandbox(),
          name: createRequest.name,
          image: TEST_IMAGE_REFERENCE,
          persistent: true,
          keepLastSnapshots: { count: 1 },
          tags: { ...createRequest.tags },
        } as VercelSandboxHandle;
        await createRequest.onCreate?.(handle);
        return handle;
      }),
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, command: { cmd?: string }) => command.cmd === '/usr/local/bin/devbox-status'
        ? { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT }
        : { exitCode: 0 }),
    } as unknown as VercelSandboxClient;
    const confirmation = vi.fn(async () => true);
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: {
        ...runner(),
        execQuiet: vi.fn(async (_command: string, args: string[]) => ({
          stdout: `sha\t${args.at(-1)}\n`,
          code: 0,
        })),
      },
      stateHome,
      client,
      confirmation,
      terminal: { attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })) },
    });

    const first = provider.up(request({ branch: 'feature/one' }));
    await vi.waitFor(() => expect(firstCreateStarted).toHaveBeenCalledOnce());
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: 'github.com/acme/repo' });
    await expect(scope.read()).resolves.toMatchObject({ teamId: 'team-1', projectId: 'project-1' });

    const second = provider.up(request({ branch: 'feature/two' }));
    let createTimeout!: ReturnType<typeof setTimeout>;
    const secondStarted = await Promise.race([
      secondCreate.then(() => true),
      new Promise<boolean>((resolve) => {
        createTimeout = setTimeout(() => resolve(false), 500);
      }),
    ]);
    clearTimeout(createTimeout);
    releaseCreate();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { exitCode: 0 },
      { exitCode: 0 },
    ]);
    expect(secondStarted).toBe(true);
    expect(createCalls).toBe(2);
    expect(confirmation).toHaveBeenCalledOnce();
  });

  it('maps provider failures through CLI dispatch without exposing credentials', async () => {
    const token = 'dispatch-vercel-secret';
    const currentLifecycle = lifecycle();
    currentLifecycle.up = vi.fn(async () => {
      throw Object.assign(new Error(`Vercel API body ${token}`), { status: 401 });
    });
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome: await mkdtemp(join(tmpdir(), 'devbox-provider-dispatch-')),
      lifecycle: currentLifecycle,
      confirmation: vi.fn(async () => true),
    });
    const local = {
      name: 'local',
      up: vi.fn(), attach: vi.fn(), stop: vi.fn(), remove: vi.fn(), list: vi.fn(), url: vi.fn(),
    } as unknown as DevboxProvider;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });

    const code = await dispatch(['--provider', 'vercel', 'feature/ui'], { stdin, stdout, stderr }, {
      repoRoot: '/repo',
      env: {
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: token,
        VERCEL_TEAM_ID: 'team-1',
        VERCEL_PROJECT_ID: 'project-1',
      },
      tty: true,
      registry: { local, vercel: provider },
    });

    expect(code).toBe(1);
    expect(output).toContain('authentication or authorization failed');
    expect(output).not.toContain(token);
  });

  it('rejects an invalid branch before Vercel Sandbox creation', async () => {
    const getOrCreate = vi.fn();
    const shell = runner();
    shell.execQuiet = vi.fn(async () => ({ stdout: '', code: 1 }));
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: shell,
      client: { getOrCreate } as unknown as VercelSandboxClient,
      stateHome: await mkdtemp(join(tmpdir(), 'devbox-provider-branch-validation-')),
      confirmation: vi.fn(async () => true),
    });

    await expect(provider.up(request({ branch: 'feature.lock' }))).rejects.toMatchObject({
      code: 'source',
    });
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(shell.exec).not.toHaveBeenCalled();
  });

  it('fails first use in a non-TTY before lifecycle creation', async () => {
    const currentLifecycle = lifecycle();
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome: await mkdtemp(join(tmpdir(), 'devbox-provider-nontty-')),
      lifecycle: () => currentLifecycle,
      confirmation: vi.fn(async () => true),
      terminal: { attach: vi.fn() },
    });

    await expect(provider.up(request({ tty: false }))).rejects.toMatchObject({
      code: 'confirmation',
      exitCode: 2,
    });
    expect(currentLifecycle.up).not.toHaveBeenCalled();
  });

  it('uses injected streams for default readline confirmation and preserves terminal stdin', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-readline-'));
    await seedBranchMetadata(stateHome);
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });
    const terminal = {
      attach: vi.fn(async (_sandbox: VercelSandboxHandle, options?: Parameters<VercelTerminalAdapter['attach']>[1]) => {
        const stream = options!.streams.stdin;
        await new Promise<void>((resolve) => {
          stream.on('data', (chunk) => {
            if (chunk.toString() === 'terminal-input') resolve();
          });
          stream.resume();
          setImmediate(() => (stream as PassThrough).write('terminal-input'));
        });
        return { status: 'detached' as const, reason: 'escape' as const };
      }),
    } as VercelTerminalAdapter;
    const currentLifecycle = lifecycle();
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      terminal,
    });
    const operation = provider.up(request({ stdin, stderr }));
    await vi.waitFor(() => expect(output).toContain('Create this Vercel sandbox? [y/N]'));
    stdin.write('yes\n');
    await expect(operation).resolves.toEqual({ exitCode: 0 });
    expect(stdin.destroyed).toBe(false);

    const refusalStdin = new PassThrough();
    const refusalLifecycle = lifecycle();
    const refusalProvider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome: await mkdtemp(join(tmpdir(), 'devbox-provider-readline-refusal-')),
      lifecycle: refusalLifecycle,
    });
    const refusal = refusalProvider.up(request({ stdin: refusalStdin }));
    refusalStdin.end('no\n');
    await expect(refusal).rejects.toMatchObject({ code: 'confirmation', exitCode: 2 });
    expect(refusalLifecycle.up).not.toHaveBeenCalled();
  });

  it('reuses stored scope for attach without a GitHub token or remote branch query', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-stored-'));
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' });
    await scope.write({ teamId: 'stored-team', projectId: 'stored-project' });
    await metadata.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      sandboxId: 'sandbox-id',
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const execQuiet = vi.fn(async () => {
      throw new Error('remote branch query must not run');
    });
    const shell = runner();
    shell.exec = vi.fn(async () => 'git@github.com:acme/repo.git');
    shell.execQuiet = execQuiet;
    const currentLifecycle = lifecycle();
    currentLifecycle.attach = vi.fn(async () => sandbox());
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const confirmation = vi.fn(async () => true);
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: shell,
      stateHome,
      lifecycle: (options) => {
        expect(options.credentials).toEqual({ token: 'new-vercel-token', teamId: 'stored-team', projectId: 'stored-project' });
        expect(options.source?.source.password).toBe('');
        return currentLifecycle;
      },
      terminal,
      confirmation,
    });

    const code = await provider.attach(request({
      branch: 'feature/ui',
      env: { VERCEL_TOKEN: 'new-vercel-token' },
      tty: true,
    }));

    expect(code).toEqual({ exitCode: 0 });
    expect(currentLifecycle.attach).toHaveBeenCalledOnce();
    expect(terminal.attach).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/vercel/sandbox' }),
      expect.objectContaining({ cwd: '/vercel/sandbox/repo' }),
    );
    expect(confirmation).not.toHaveBeenCalled();
    expect(execQuiet).not.toHaveBeenCalled();
  });

  it('cheaply re-enters a prepared sandbox without prompting and restores drifted routes', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-reattach-'));
    const remote = 'github.com/acme/repo';
    const head = 'b'.repeat(40);
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' });
    await scope.write({ teamId: 'stored-team', projectId: 'stored-project' });
    await metadata.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      sandboxId: 'sandbox-id',
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
      displayCredentials: { username: 'devbox', password: DISPLAY_TOKEN },
      appPorts: {
        sandboxId: 'sandbox-id',
        selected: [3000],
        relays: [{ logicalPort: 3000, relayPort: 43_000, label: 'next' }],
        applied: [6080, 43_000],
        fingerprint: 'f'.repeat(64),
        detectorVersion: 2,
        revision: head,
      },
    });
    const marker = {
      sandboxId: 'sandbox-id',
      revision: head,
      githubTokenHash: createHash('sha256').update('github-secret', 'utf8').digest('hex'),
      environmentHash: createHash('sha256').update(JSON.stringify([['API_KEY', 'dotenv-secret']]), 'utf8').digest('hex'),
    };
    const commands: Array<{ cmd?: string; args?: string[] }> = [];
    const updatedPorts: number[][] = [];
    const client = {
      runCommand: async (_sandbox: unknown, request: { cmd?: string; args?: string[] }) => {
        commands.push(request);
        if (request.cmd === 'cat' && request.args?.[0] === '/vercel/.devbox/runtime/setup.status') {
          return {
            exitCode: 0,
            stdout: async () => JSON.stringify({ status: 'succeeded', startedAt: 1, finishedAt: 2 }),
          };
        }
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT };
        }
        if (isRelayControl(request)) {
          return {
            exitCode: 0,
            stdout: async () => relayControlResponse((request.args ?? []).slice(1), { 3000: 43_000 }),
          };
        }
        const script = request.cmd === 'sh' ? request.args?.[1] ?? '' : '';
        if (script.includes('cat /vercel/.devbox/runtime/preparation.json')) {
          return {
            exitCode: 0,
            stdout: async () => `${JSON.stringify(marker)}\n--DEVBOX--\n${head}\n`,
          };
        }
        return { exitCode: 0 };
      },
      writeFiles: async () => {},
      updatePorts: async (_sandbox: unknown, ports: number[]) => {
        updatedPorts.push([...ports]);
      },
    } as unknown as VercelSandboxClient;
    const box = {
      ...sandbox(),
      routes: [
        { port: 6080, subdomain: '', url: 'https://sandbox.example/6080' },
        { port: 43_000, subdomain: '', url: 'https://sandbox.example/43000' },
      ],
      domain: (port: number) => `https://sandbox.example/${port}`,
    };
    const currentLifecycle = lifecycle();
    currentLifecycle.attach = vi.fn(async () => box as unknown as VercelSandboxHandle);
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const prompt = vi.fn(() => {
      throw new Error('app-port prompt must never appear on a cheap attach');
    });
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      terminal,
      client,
      appPortPrompt: prompt,
    });
    const stderr = new PassThrough();
    let stderrText = '';
    stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });

    const code = await provider.attach(request({
      env: {
        HOME: '/tmp/devbox-vercel-provider-no-pi',
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'stored-token',
        VERCEL_TEAM_ID: 'stored-team',
        VERCEL_PROJECT_ID: 'stored-project',
      },
      runtimeEnvironment: { API_KEY: 'dotenv-secret' },
      stderr,
    }));

    expect(code).toEqual({ exitCode: 0 });
    expect(stderrText).toContain('Re-entering the prepared sandbox (no re-provisioning)');
    expect(prompt).not.toHaveBeenCalled();
    // Verified relay plus matching routes: nothing is republished, so the URL
    // the user copied last time still works.
    expect(updatedPorts).toEqual([]);
    expect(stderrText).toContain('3000: https://sandbox.example/43000  (next — public)');
    expect(stderrText).not.toContain('43000:');
    // The repository is never scanned on this path; the only Sandbox work is
    // the preparation/display evidence and the relay health check.
    expect(commands.every((command) =>
      command.cmd === '/usr/local/bin/devbox-status'
      || command.cmd === 'cat'
      || command.cmd === 'stat'
      || isRelayControl(command)
      || (command.args?.[1] ?? '').includes('cat /vercel/.devbox/runtime/preparation.json')
      || (command.cmd === 'sh' && (command.args?.[1] ?? '').includes('/vercel/.devbox/runtime/heartbeat'))))
      .toBe(true);
    expect(commands.filter(isRelayControl).map((command) => command.args?.[1])).toEqual(['status']);
    expect(terminal.attach).toHaveBeenCalledOnce();
  });

  it('honors --expose-ports on an otherwise cheap attach', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-reattach-'));
    const remote = 'github.com/acme/repo';
    const head = 'b'.repeat(40);
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' });
    await scope.write({ teamId: 'stored-team', projectId: 'stored-project' });
    await metadata.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      sandboxId: 'sandbox-id',
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
      displayCredentials: { username: 'devbox', password: DISPLAY_TOKEN },
      appPorts: {
        sandboxId: 'sandbox-id',
        selected: [3000],
        relays: [{ logicalPort: 3000, relayPort: 43_000, label: 'next' }],
        applied: [6080, 43_000],
        fingerprint: 'f'.repeat(64),
        detectorVersion: 2,
        revision: head,
      },
    });
    const marker = {
      sandboxId: 'sandbox-id',
      revision: head,
      githubTokenHash: createHash('sha256').update('github-secret', 'utf8').digest('hex'),
      environmentHash: createHash('sha256').update(JSON.stringify([['API_KEY', 'dotenv-secret']]), 'utf8').digest('hex'),
    };
    const updatedPorts: number[][] = [];
    const client = {
      runCommand: async (_sandbox: unknown, request: { cmd?: string; args?: string[] }) => {
        if (request.cmd === 'cat' && request.args?.[0] === '/vercel/.devbox/runtime/setup.status') {
          return {
            exitCode: 0,
            stdout: async () => JSON.stringify({ status: 'succeeded', startedAt: 1, finishedAt: 2 }),
          };
        }
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT };
        }
        const script = request.cmd === 'sh' ? request.args?.[1] ?? '' : '';
        if (script.includes('cat /vercel/.devbox/runtime/preparation.json')) {
          return {
            exitCode: 0,
            stdout: async () => `${JSON.stringify(marker)}\n--DEVBOX--\n${head}\n`,
          };
        }
        if (request.cmd === 'git' && request.args?.includes('rev-parse')) {
          return { exitCode: 0, stdout: async () => `${head}\n` };
        }
        if (isRelayControl(request)) {
          return {
            exitCode: 0,
            stdout: async () => relayControlResponse((request.args ?? []).slice(1), {}),
          };
        }
        return { exitCode: 0 };
      },
      writeFiles: async () => {},
      updatePorts: async (_sandbox: unknown, ports: number[]) => {
        updatedPorts.push([...ports]);
      },
    } as unknown as VercelSandboxClient;
    const box = {
      ...sandbox(),
      routes: [{ port: 6080, subdomain: '', url: 'https://sandbox.example/6080' }],
      domain: (port: number) => `https://sandbox.example/${port}`,
    };
    const currentLifecycle = lifecycle();
    currentLifecycle.attach = vi.fn(async () => box as unknown as VercelSandboxHandle);
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const prompt = vi.fn(() => {
      throw new Error('app-port prompt must never appear on a cheap attach');
    });
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      terminal,
      client,
      appPortPrompt: prompt,
    });
    const stderr = new PassThrough();
    let stderrText = '';
    stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });

    const code = await provider.attach(request({
      env: {
        HOME: '/tmp/devbox-vercel-provider-no-pi',
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'stored-token',
        VERCEL_TEAM_ID: 'stored-team',
        VERCEL_PROJECT_ID: 'stored-project',
      },
      runtimeEnvironment: { API_KEY: 'dotenv-secret' },
      exposePorts: [4000],
      stderr,
    }));

    expect(code).toEqual({ exitCode: 0 });
    expect(stderrText).toContain('exposing 4000 from --expose-ports');
    expect(prompt).not.toHaveBeenCalled();
    // The explicit opt-in still goes through a relay; 4000 itself is not a route.
    expect(updatedPorts).toEqual([[6080, 44_000]]);
    expect(stderrText).toContain('4000: https://sandbox.example/44000');
    expect(terminal.attach).toHaveBeenCalledOnce();
  });

  it('reconciles an interrupted route update before reusing recorded routes', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-reattach-'));
    const remote = 'github.com/acme/repo';
    const head = 'b'.repeat(40);
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' });
    await scope.write({ teamId: 'stored-team', projectId: 'stored-project' });
    await metadata.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      sandboxId: 'sandbox-id',
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
      displayCredentials: { username: 'devbox', password: DISPLAY_TOKEN },
      appPorts: {
        sandboxId: 'sandbox-id',
        selected: [],
        relays: [],
        applied: [6080],
        fingerprint: 'f'.repeat(64),
        detectorVersion: 2,
        revision: head,
      },
      pendingAppPorts: {
        sandboxId: 'sandbox-id',
        previous: { relays: [], applied: [6080] },
        desired: {
          relays: [{ logicalPort: 3000, relayPort: 43_000, label: 'next' }],
          applied: [6080, 43_000],
        },
        selected: [3000],
        fingerprint: 'f'.repeat(64),
        detectorVersion: 2,
        revision: head,
      },
    });
    const marker = {
      sandboxId: 'sandbox-id',
      revision: head,
      githubTokenHash: createHash('sha256').update('github-secret', 'utf8').digest('hex'),
      environmentHash: createHash('sha256').update(JSON.stringify([['API_KEY', 'dotenv-secret']]), 'utf8').digest('hex'),
    };
    const updatedPorts: number[][] = [];
    const client = {
      runCommand: async (_sandbox: unknown, request: { cmd?: string; args?: string[] }) => {
        if (request.cmd === 'cat' && request.args?.[0] === '/vercel/.devbox/runtime/setup.status') {
          return {
            exitCode: 0,
            stdout: async () => JSON.stringify({ status: 'succeeded', startedAt: 1, finishedAt: 2 }),
          };
        }
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT };
        }
        if (isRelayControl(request)) {
          return {
            exitCode: 0,
            stdout: async () => relayControlResponse((request.args ?? []).slice(1), { 3000: 43_000 }),
          };
        }
        const script = request.cmd === 'sh' ? request.args?.[1] ?? '' : '';
        if (script.includes('cat /vercel/.devbox/runtime/preparation.json')) {
          return {
            exitCode: 0,
            stdout: async () => `${JSON.stringify(marker)}\n--DEVBOX--\n${head}\n`,
          };
        }
        return { exitCode: 0 };
      },
      writeFiles: async () => {},
      updatePorts: async (_sandbox: unknown, ports: number[]) => {
        updatedPorts.push([...ports]);
      },
    } as unknown as VercelSandboxClient;
    // Live routes and a live relay both match pending.desired: it commits.
    const box = {
      ...sandbox(),
      routes: [
        { port: 6080, subdomain: '', url: 'https://sandbox.example/6080' },
        { port: 43_000, subdomain: '', url: 'https://sandbox.example/43000' },
      ],
      domain: (port: number) => `https://sandbox.example/${port}`,
    };
    const currentLifecycle = lifecycle();
    currentLifecycle.attach = vi.fn(async () => box as unknown as VercelSandboxHandle);
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      terminal,
      client,
    });
    const stderr = new PassThrough();
    let stderrText = '';
    stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });

    const code = await provider.attach(request({
      env: {
        HOME: '/tmp/devbox-vercel-provider-no-pi',
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'stored-token',
        VERCEL_TEAM_ID: 'stored-team',
        VERCEL_PROJECT_ID: 'stored-project',
      },
      runtimeEnvironment: { API_KEY: 'dotenv-secret' },
      stderr,
    }));

    expect(code).toEqual({ exitCode: 0 });
    expect(stderrText).toContain('committing the interrupted route update');
    expect(updatedPorts).toEqual([]);
    const stored = await metadata.read();
    expect(stored?.pendingAppPorts).toBeUndefined();
    expect(stored?.appPorts?.applied).toEqual([6080, 43_000]);
    expect(stored?.appPorts?.relays).toEqual([{ logicalPort: 3000, relayPort: 43_000, label: 'next' }]);
  });

  it('gives a request timeout or vcpus precedence over stored configuration on up', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-timeout-precedence-'));
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({
      remote,
      branch: 'feature/ui',
      packageVersion: '0.1.2',
      scope: { teamId: 'team-1', projectId: 'project-1' },
    });
    await createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' }).write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      sandboxId: identity.name,
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
        vcpus: 4,
      },
    });
    const seen: VercelLifecycleOptions[] = [];
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: (options) => {
        seen.push(options);
        return lifecycle();
      },
      confirmation: vi.fn(async () => true),
      terminal: { attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })) },
    });

    await provider.up(request({ timeoutMs: 7_200_000 }));
    expect(seen[0]?.timeoutMs).toBe(7_200_000);
    expect(seen[0]?.vcpus).toBe(4);

    await provider.up(request({}));
    expect(seen[1]?.timeoutMs).toBe(1_800_000);
    expect(seen[1]?.vcpus).toBe(4);

    await provider.up(request({ vcpus: 2 }));
    expect(seen[2]?.timeoutMs).toBe(1_800_000);
    expect(seen[2]?.vcpus).toBe(2);
  });

  it('renders only concise stop usage output', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-stop-'));
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' });
    await scope.write({ teamId: 'stored-team', projectId: 'stored-project' });
    await metadata.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const currentLifecycle = lifecycle();
    currentLifecycle.stop = vi.fn(async () => ({
      name: identity.name,
      sessions: [],
      finalSession: { id: 'session', status: 'stopped' as const },
      snapshot: { id: 'snapshot-1', status: 'created' },
      activeCpuUsageMs: 123,
      networkTransfer: { ingress: 4, egress: 5 },
    }));
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });
    const shell = runner();
    shell.exec = vi.fn(async () => 'git@github.com:acme/repo.git');
    shell.execQuiet = vi.fn(async () => { throw new Error('remote query must not run'); });
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: shell,
      stateHome,
      lifecycle: currentLifecycle,
    });

    await expect(provider.stop(request({
      env: { VERCEL_TOKEN: 'new-vercel-token' },
      stderr,
      tty: false,
    }))).resolves.toEqual({ exitCode: 0 });

    expect(output).toContain(`${identity.name}: paused`);
    expect(output).toContain('snapshot: snapshot-1 created');
    expect(output).toContain('attach resumes from this retained snapshot');
    expect(output).toContain('cpu: 123ms');
    expect(output).toContain('network: ingress=4 egress=5');
    expect(output).not.toContain('session');
    expect(output).not.toContain('new-vercel-token');

    currentLifecycle.pause = vi.fn(async () => ({
      name: identity.name,
      sessions: [],
      finalSession: { id: 'session', status: 'stopped' as const },
      snapshot: { id: 'snapshot-2', status: 'created' as const },
    }));
    await expect(provider.pause(request({
      env: { VERCEL_TOKEN: 'new-vercel-token' },
      stderr,
      tty: false,
    }))).resolves.toEqual({ exitCode: 0 });

    expect(currentLifecycle.pause).toHaveBeenCalledOnce();
    expect(output).toContain(`${identity.name}: paused`);
    expect(output).toContain('snapshot: snapshot-2 created');
  });

  it('routes list, URL/open, and remove through stored metadata without remote queries', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-actions-'));
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' });
    await scope.write({ teamId: 'stored-team', projectId: 'stored-project' });
    await metadata.write({
      displayCredentials: { username: 'devbox', password: DISPLAY_TOKEN },
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const currentLifecycle = lifecycle();
    currentLifecycle.list = vi.fn(async () => [{
      name: identity.name,
      status: 'running',
      tags: { ...identity.tags },
    }]);
    currentLifecycle.routes = vi.fn(async () => [
      { port: 3000, subdomain: 'sandbox', url: 'https://sandbox.example/3000' },
      { port: 8080, subdomain: 'sandbox', url: 'https://sandbox.example/8080' },
      { port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' },
    ]);
    currentLifecycle.remove = vi.fn(async () => ({
      verified: true,
      sandboxDeleted: true,
      snapshotsCleaned: true,
      sandboxMissing: false,
      snapshotIds: [],
      residualSandboxIds: [],
      residualSnapshotIds: [],
      finalSessions: [],
      errors: [],
    }));
    const shell = runner();
    shell.exec = vi.fn(async () => 'git@github.com:acme/repo.git');
    shell.execQuiet = vi.fn(async () => { throw new Error('remote query must not run'); });
    const opener = vi.fn();
    const provider = createVercelProvider({ runner: shell, stateHome, lifecycle: currentLifecycle, opener });
    const listStderr = new PassThrough();
    const listOutput: string[] = [];
    listStderr.on('data', (chunk) => listOutput.push(chunk.toString()));

    await expect(provider.list(request({ stderr: listStderr, env: { VERCEL_TOKEN: 'new-vercel-token' } }))).resolves.toEqual({ exitCode: 0 });
    expect(listOutput.join('')).toContain(`${identity.name} running`);
    expect(listOutput.join('')).toContain(`identity=${identity.tags.identity}`);

    const urlStdout = new PassThrough();
    const urls: string[] = [];
    urlStdout.on('data', (chunk) => urls.push(chunk.toString()));
    await expect(provider.url(request({ stdout: urlStdout, open: true, env: { VERCEL_TOKEN: 'new-vercel-token' } }))).resolves.toEqual({ exitCode: 0 });
    expect(urls.join('')).toBe([
      '3000: https://sandbox.example/3000  (public)',
      `6080: https://sandbox.example/6080/vnc.html?token=${DISPLAY_TOKEN}&autoconnect=1  (noVNC display)`,
      '8080: https://sandbox.example/8080  (public)',
      '',
    ].join('\n'));
    expect(opener).toHaveBeenCalledWith(`https://sandbox.example/6080/vnc.html?token=${DISPLAY_TOKEN}&autoconnect=1`);
    currentLifecycle.routes = vi.fn(async () => []);
    await expect(provider.url(request({ env: { VERCEL_TOKEN: 'new-vercel-token' } }))).rejects.toMatchObject({
      code: 'route',
      exitCode: 2,
    });

    const removeStderr = new PassThrough();
    const removalOutput: string[] = [];
    removeStderr.on('data', (chunk) => removalOutput.push(chunk.toString()));
    await expect(provider.remove(request({ stderr: removeStderr, env: { VERCEL_TOKEN: 'new-vercel-token' } }))).resolves.toEqual({ exitCode: 0 });
    expect(removalOutput.join('')).toContain('cleanup verified');
    expect(shell.execQuiet).not.toHaveBeenCalled();
  });

  it('maps terminal exit status and detaches without lifecycle cleanup', async () => {
    const currentLifecycle = lifecycle();
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-terminal-result-'));
    await seedBranchMetadata(stateHome);
    const terminal = { attach: vi.fn(async () => ({ status: 'exited' as const, code: 23 })) } as VercelTerminalAdapter;
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      terminal,
      confirmation: vi.fn(async () => true),
    });

    await expect(provider.up(request())).resolves.toEqual({ exitCode: 23 });
    terminal.attach = vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const }));
    await expect(provider.up(request({ env: {
      GH_TOKEN: 'github-secret',
      VERCEL_TOKEN: 'vercel-secret',
      VERCEL_TEAM_ID: 'team-1',
      VERCEL_PROJECT_ID: 'project-1',
    } }))).resolves.toEqual({ exitCode: 0 });
    expect(currentLifecycle.stop).not.toHaveBeenCalled();
    expect(currentLifecycle.remove).not.toHaveBeenCalled();
  });

  it('passes recovered identity and snapshots directly into removal without seeding metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-remove-recovery-'));
    const remote = 'github.com/acme/repo';
    const env = { VERCEL_TOKEN: 'vercel-secret', VERCEL_TEAM_ID: 'team-1', VERCEL_PROJECT_ID: 'project-1' };
    let partial = true;
    const seenIdentities: string[] = [];
    const recovered = createVercelIdentity({
      remote,
      branch: 'feature/recover',
      scope: { teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID },
    });
    const client = {
      listSandboxes: vi.fn(async () => [{
        name: recovered.name,
        status: 'running' as const,
        persistent: true,
        currentSnapshotId: 'recovered-snapshot',
        tags: { ...recovered.tags },
      }]),
    } as unknown as VercelSandboxClient;
    const lifecycleFactory = (options: VercelLifecycleOptions): VercelLifecycle => ({
      up: vi.fn(),
      get: vi.fn(),
      attach: vi.fn(),
      list: vi.fn(),
      routes: vi.fn(),
      url: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(async () => {
        expect(options.recovery?.identity.name).toBe(recovered.name);
        expect(options.recovery?.snapshotIds).toEqual(['recovered-snapshot']);
        expect(options.branchMetadataStore).toBeDefined();
        seenIdentities.push(options.recovery!.identity.tags.identity);
        if (partial) {
          return {
            verified: false,
            sandboxDeleted: false,
            snapshotsCleaned: false,
            sandboxMissing: false,
            snapshotIds: ['recovered-snapshot'],
            residualSandboxIds: [recovered.name],
            residualSnapshotIds: ['recovered-snapshot'],
            finalSessions: [],
            errors: ['sandbox remained'],
          };
        }
        return {
          verified: true,
          sandboxDeleted: true,
          snapshotsCleaned: true,
          sandboxMissing: true,
          snapshotIds: ['recovered-snapshot'],
          residualSandboxIds: [],
          residualSnapshotIds: [],
          finalSessions: [],
          errors: [],
        };
      }),
    });
    const shell: ShellRunner = {
      exec: vi.fn(async () => 'git@github.com:Acme/Repo.git'),
      execQuiet: vi.fn(async () => { throw new Error('remote branch query must not run'); }),
      spawnInherit: vi.fn(),
    };
    const provider = createVercelProvider({ runner: shell, stateHome, lifecycle: lifecycleFactory, client });

    await expect(provider.remove(request({ branch: 'feature/recover', env, tty: false }))).rejects.toMatchObject({ code: 'cleanup' });
    const branchStore = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/recover' });
    await expect(branchStore.read()).resolves.toBeNull();
    expect(seenIdentities).toHaveLength(1);

    partial = false;
    await expect(provider.remove(request({ branch: 'feature/recover', env, tty: false }))).resolves.toEqual({ exitCode: 0 });
    await expect(branchStore.read()).resolves.toBeNull();
    expect(seenIdentities).toHaveLength(2);
    expect(seenIdentities[0]).toBe(seenIdentities[1]);
    expect(shell.execQuiet).not.toHaveBeenCalled();
  });

  it('removes recovered cloud state when branch metadata read is unavailable', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-remove-read-failure-'));
    const remote = 'github.com/acme/repo';
    const branch = 'feature/recover';
    const recovered = createVercelIdentity({
      remote,
      branch,
      scope: { teamId: 'team-1', projectId: 'project-1' },
    });
    const branchStore = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch });
    await mkdir(dirname(branchStore.path), { recursive: true });
    for (let directory = dirname(branchStore.path); directory !== stateHome; directory = dirname(directory)) {
      await chmod(directory, 0o700);
    }
    await mkdir(branchStore.path);
    const handle = {
      ...sandbox(),
      name: recovered.name,
      status: 'stopped' as const,
      tags: { ...recovered.tags },
    };
    const client = {
      listSandboxes: vi.fn(async () => [{
        name: recovered.name,
        status: 'stopped' as const,
        persistent: true,
        tags: { ...recovered.tags },
      }]),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({ runner: runner(), stateHome, client, resolveImage: resolveTestImage });

    await expect(provider.remove(request({ branch, tty: false }))).resolves.toEqual({ exitCode: 0 });
    expect(client.get).toHaveBeenCalledWith(expect.objectContaining({ name: recovered.name }));
    expect(client.deleteSandbox).toHaveBeenCalledOnce();
  });

  it('reports a no-op removal honestly instead of claiming cleanup', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-remove-absent-'));
    // Nothing local, nothing in the cloud: this is what a mistyped or
    // already-removed branch looks like.
    const client = {
      listSandboxes: vi.fn(async () => []),
      get: vi.fn(),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({ runner: runner(), stateHome, client, resolveImage: resolveTestImage });

    const stderr = new PassThrough();
    const output: string[] = [];
    stderr.on('data', (chunk) => output.push(chunk.toString()));

    await expect(provider.remove(request({ branch: 'never-existed', stderr, tty: false })))
      .resolves.toEqual({ exitCode: 0 });

    const text = output.join('');
    // Idempotent, but it must not read as though a box was deleted.
    expect(text).toContain('No Vercel sandbox exists for never-existed');
    expect(text).not.toContain('cleanup verified');
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it('recovers and removes a lost old-version sandbox from authoritative branch tags', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-recovery-old-version-'));
    const remote = 'github.com/acme/repo';
    const env = { VERCEL_TOKEN: 'vercel-secret', VERCEL_TEAM_ID: 'team-1', VERCEL_PROJECT_ID: 'project-1' };
    const oldIdentity = createVercelIdentity({
      remote,
      branch: 'feature/recover',
      packageVersion: '0.0.1',
      scope: { teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID },
    });
    let deleted = false;
    const live = {
      ...sandbox(),
      name: oldIdentity.name,
      status: 'stopped' as const,
      persistent: true,
      image: TEST_IMAGE_REFERENCE,
      tags: { ...oldIdentity.tags },
    } as VercelSandboxHandle;
    const client = {
      listSandboxes: vi.fn(async () => [{
        name: oldIdentity.name,
        status: 'stopped' as const,
        persistent: true,
        tags: { ...oldIdentity.tags },
      }]),
      get: vi.fn(async ({ name }: { name: string }) => {
        if (name !== oldIdentity.name || deleted) {
          throw Object.assign(new Error('sandbox not found'), { status: 404 });
        }
        return live;
      }),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async ({ name }: { name: string }) => {
        if (name !== oldIdentity.name) throw Object.assign(new Error('snapshot listing failed'), { status: 500 });
        return [];
      }),
      deleteSandbox: vi.fn(async () => { deleted = true; }),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      client,
    });

    await expect(provider.remove(request({ branch: 'feature/recover', env, tty: false }))).resolves.toEqual({ exitCode: 0 });
    expect(client.listSandboxes).toHaveBeenCalledWith({
      credentials: { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID },
      tags: { provider: 'vercel', repository: oldIdentity.tags.repository },
    });
    expect(client.get).toHaveBeenCalledWith(expect.objectContaining({ name: oldIdentity.name }));
    expect(client.deleteSandbox).toHaveBeenCalledOnce();
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/recover' });
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('treats an authoritative empty recovery list as absent without synthesizing a name', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-recovery-absent-'));
    const remote = 'github.com/acme/repo';
    const env = { VERCEL_TOKEN: 'vercel-secret', VERCEL_TEAM_ID: 'team-1', VERCEL_PROJECT_ID: 'project-1' };
    const client = {
      listSandboxes: vi.fn(async () => []),
      get: vi.fn(),
      deleteSandbox: vi.fn(),
      listSnapshots: vi.fn(),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({ runner: runner(), stateHome, client, resolveImage: resolveTestImage });

    await expect(provider.remove(request({ branch: 'feature/recover', env, tty: false }))).resolves.toEqual({ exitCode: 0 });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/recover' });
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('fails lost-metadata removal closed when branch-tagged live resources are ambiguous', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-recovery-ambiguous-'));
    const remote = 'github.com/acme/repo';
    const env = { VERCEL_TOKEN: 'vercel-secret', VERCEL_TEAM_ID: 'team-1', VERCEL_PROJECT_ID: 'project-1' };
    const first = createVercelIdentity({ remote, branch: 'feature/recover', packageVersion: '0.0.1', scope: { teamId: 'team-1', projectId: 'project-1' } });
    const second = createVercelIdentity({ remote, branch: 'feature/recover', packageVersion: '0.0.2', scope: { teamId: 'team-1', projectId: 'project-1' } });
    const client = {
      listSandboxes: vi.fn(async () => [
        { name: first.name, status: 'running' as const, persistent: true, tags: { ...first.tags } },
        { name: second.name, status: 'running' as const, persistent: true, tags: { ...second.tags } },
      ]),
      get: vi.fn(),
      deleteSandbox: vi.fn(),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({ runner: runner(), stateHome, client, resolveImage: resolveTestImage });

    await expect(provider.remove(request({ branch: 'feature/recover', env, tty: false }))).rejects.toMatchObject({
      code: 'identity',
      exitCode: 2,
    });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/recover' });
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('does not recover or delete a same-branch sandbox from another Vercel scope', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-recovery-foreign-scope-'));
    const remote = 'github.com/acme/repo';
    const env = { VERCEL_TOKEN: 'vercel-secret', VERCEL_TEAM_ID: 'team-1', VERCEL_PROJECT_ID: 'project-1' };
    const foreign = createVercelIdentity({
      remote,
      branch: 'feature/recover',
      scope: { teamId: 'team-other', projectId: 'project-other' },
    });
    const client = {
      listSandboxes: vi.fn(async () => [{
        name: foreign.name,
        status: 'running' as const,
        persistent: true,
        tags: { ...foreign.tags },
      }]),
      get: vi.fn(),
      deleteSandbox: vi.fn(),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({ runner: runner(), stateHome, client, resolveImage: resolveTestImage });

    const stderr = new PassThrough();
    const output: string[] = [];
    stderr.on('data', (chunk) => output.push(chunk.toString()));

    await expect(provider.remove(request({ branch: 'feature/recover', env, stderr, tty: false })))
      .resolves.toEqual({ exitCode: 0 });
    expect(client.get).not.toHaveBeenCalled();
    expect(client.deleteSandbox).not.toHaveBeenCalled();

    // Declining to delete another scope's box is right; claiming none exists
    // while --list shows one is not.
    const text = output.join('');
    expect(text).not.toContain('nothing to remove');
    expect(text).toContain('another Vercel team/project and were not touched');
    expect(text).toContain(foreign.name);
    expect(text).toContain('VERCEL_TEAM_ID/VERCEL_PROJECT_ID');
  });

  it('recovers the scoped sandbox and ignores a foreign-scope record for the same branch', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-recovery-scoped-own-'));
    const remote = 'github.com/acme/repo';
    const env = { VERCEL_TOKEN: 'vercel-secret', VERCEL_TEAM_ID: 'team-1', VERCEL_PROJECT_ID: 'project-1' };
    const own = createVercelIdentity({
      remote,
      branch: 'feature/recover',
      scope: { teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID },
    });
    const foreign = createVercelIdentity({
      remote,
      branch: 'feature/recover',
      scope: { teamId: 'team-other', projectId: 'project-other' },
    });
    const handle = {
      ...sandbox(),
      name: own.name,
      status: 'stopped' as const,
      tags: { ...own.tags },
    };
    let deleted = false;
    const client = {
      listSandboxes: vi.fn(async () => [
        { name: foreign.name, status: 'running' as const, persistent: true, tags: { ...foreign.tags } },
        { name: own.name, status: 'stopped' as const, persistent: true, tags: { ...own.tags } },
      ]),
      get: vi.fn(async ({ name }: { name: string }) => {
        if (name !== own.name || deleted) {
          throw Object.assign(new Error('sandbox not found'), { status: 404 });
        }
        return handle;
      }),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => { deleted = true; }),
    } as unknown as VercelSandboxClient;
    const provider = createVercelProvider({ runner: runner(), stateHome, client, resolveImage: resolveTestImage });

    await expect(provider.remove(request({ branch: 'feature/recover', env, tty: false }))).resolves.toEqual({ exitCode: 0 });
    expect(client.get).toHaveBeenCalledWith(expect.objectContaining({ name: own.name }));
    expect(client.deleteSandbox).toHaveBeenCalledOnce();
  });

  it('routes terminal transport failures through centralized redacted errors without duplicate output', async () => {
    const token = 'terminal-transport-secret';
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async (_sandbox, options) => {
        options?.onError?.({
          cause: new Error(`WebSocket failed with ${token}`),
          message: `WebSocket failed with ${token}`,
        });
        return { status: 'detached' as const, reason: 'error' as const };
      }),
    };
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome: await mkdtemp(join(tmpdir(), 'devbox-provider-terminal-error-')),
      lifecycle: lifecycle(),
      terminal,
      confirmation: vi.fn(async () => true),
    });

    await expect(provider.up(request({ stderr, env: {
      GH_TOKEN: 'github-secret',
      VERCEL_TOKEN: token,
      VERCEL_TEAM_ID: 'team-1',
      VERCEL_PROJECT_ID: 'project-1',
    } }))).rejects.toMatchObject({ code: 'api', exitCode: 1 });
    expect(output).not.toContain(token);
    expect(output).not.toContain('WebSocket failed');
  });

  it('reuses stored scope on up without reconfirming an existing sandbox', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-up-existing-'));
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch: 'feature/ui' });
    await scope.write({ teamId: 'stored-team', projectId: 'stored-project' });
    await metadata.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/ui',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const currentLifecycle = lifecycle();
    currentLifecycle.up = vi.fn(async () => sandbox());
    const confirmation = vi.fn(async () => true);
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      terminal,
      confirmation,
    });

    await expect(provider.up(request({
      env: {
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'new-vercel-token',
      },
    }))).resolves.toEqual({ exitCode: 0 });
    expect(currentLifecycle.up).toHaveBeenCalledOnce();
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('rejects unsafe runtime environment keys before any sandbox work', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-up-unsafe-keys-'));
    await seedBranchMetadata(stateHome);
    const currentLifecycle = lifecycle();
    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: currentLifecycle,
      terminal: { attach: vi.fn() } as unknown as VercelTerminalAdapter,
      confirmation: vi.fn(async () => true),
    });

    await expect(provider.up(request({
      runtimeEnvironment: { 'BAD$(id)': 'dummy' },
    }))).rejects.toThrow('invalid variable name');
    expect(currentLifecycle.up).not.toHaveBeenCalled();

    await expect(provider.attach(request({
      runtimeEnvironment: { BASH_ENV: 'dummy' },
    }))).rejects.toThrow('invalid variable name');
    expect(currentLifecycle.attach).not.toHaveBeenCalled();
  });

  it('confirms first-use scope before creating and attaches a terminal in sandbox cwd', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-provider-first-use-'));
    await seedBranchMetadata(stateHome);
    const captured: VercelLifecycleOptions[] = [];
    const currentLifecycle = lifecycle();
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'exited' as const, code: 0 })),
    };
    const confirmation = vi.fn(async () => true);
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });

    const provider = createVercelProvider({
      resolveImage: resolveTestImage,
      runner: runner(),
      stateHome,
      lifecycle: (options) => {
        captured.push(options);
        return currentLifecycle;
      },
      terminal,
      confirmation,
    });

    const code = await provider.up(request({ stderr }));

    expect(code).toEqual({ exitCode: 0 });
    expect(confirmation).toHaveBeenCalledWith(
      { teamId: 'team-1', projectId: 'project-1' },
      expect.objectContaining({ tty: true }),
    );
    expect(currentLifecycle.up).toHaveBeenCalledOnce();
    expect(terminal.attach).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/vercel/sandbox' }),
      expect.objectContaining({
        cwd: '/vercel/sandbox/repo',
        tty: true,
        streams: expect.objectContaining({ stdin: expect.any(PassThrough), stdout: expect.any(PassThrough), stderr }),
      }),
    );
    expect(captured[0].source?.source.password).toBe('github-secret');
    expect(output).toContain('Vercel team: team-1');
    expect(output).toContain('local dirty files and unpushed commits are not copied');
    expect(output).not.toContain('github-secret');
    expect(output).not.toContain('vercel-secret');
  });
});
