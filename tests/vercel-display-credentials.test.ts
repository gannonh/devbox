import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { access, readFile, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dispatch } from '../src/cli.js';
import { defaultProviderRegistry } from '../src/providers/registry.js';
import { createVercelProvider } from '../src/providers/vercel/provider.js';
import { createVercelBranchMetadataStore, createVercelScopeMetadataStore } from '../src/providers/vercel/metadata.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import type { VercelLifecycle } from '../src/providers/vercel/lifecycle.js';
import type { ShellRunner } from '../src/lib/shell.js';
import { createVercelLifecycle } from '../src/providers/vercel/lifecycle.js';
import type { GitHubSourcePlan } from '../src/providers/vercel/source.js';
import type { VercelSandboxClient, VercelSandboxHandle } from '../src/providers/vercel/client.js';
import type { VercelTerminalAdapter } from '../src/providers/vercel/terminal.js';
import {
  DISPLAY_CODE_PATTERN,
  DISPLAY_USERNAME,
  generateDisplayPassword,
  getDisplayCredentials,
} from '../src/providers/vercel/display-credentials.js';
import { DISPLAY_STATUS_OUTPUT } from './vercel-display-status.fixture.js';
import { resolveTestImage, TEST_IMAGE_REFERENCE } from './vercel-image.fixture.js';

describe('Vercel display credentials', () => {
  it('stores the dedicated credential field with restrictive metadata permissions', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-credentials-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    const password = generateDisplayPassword();

    await store.write({
      displayCredentials: { username: DISPLAY_USERNAME, password },
    });

    await expect(store.read()).resolves.toMatchObject({
      displayCredentials: { username: DISPLAY_USERNAME, password },
    });
    await expect(stat(store.path).then((value) => value.mode & 0o777)).resolves.toBe(0o600);
    await expect(stat(dirname(store.path)).then((value) => value.mode & 0o777)).resolves.toBe(0o700);
    const stored = await readFile(store.path, 'utf8');
    expect(stored).toContain(password);
    expect(stored).not.toContain('VERCEL_TOKEN');
    expect(stored).not.toContain('github-secret');
  });

  it('rejects non-display secrets before writing metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-secret-boundary-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });

    await expect(store.write({
      displayCredentials: { username: DISPLAY_USERNAME, password: generateDisplayPassword() },
      token: 'vercel-token',
    } as never)).rejects.toThrow(/unknown.*token/i);
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects credential-bearing source URLs before writing metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-source-secret-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });

    await expect(store.write({
      configuration: {
        imageReference: 'image',
        sourceUrl: 'https://user:token@github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/display',
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    })).rejects.toThrow(/sourceUrl.*credentials/i);
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns an existing credential without rotating it', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-existing-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    const credentials = { username: DISPLAY_USERNAME, password: generateDisplayPassword() };
    await store.write({ displayCredentials: credentials });

    await expect(getDisplayCredentials(store)).resolves.toEqual({
      credentials,
      generated: false,
    });
    await expect(store.read()).resolves.toMatchObject({ displayCredentials: credentials });
  });

  it('generates and persists a credential when the field is absent', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-generate-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});

    const result = await getDisplayCredentials(store);

    expect(result.generated).toBe(true);
    expect(result.credentials.username).toBe(DISPLAY_USERNAME);
    expect(result.credentials.password).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(store.read()).resolves.toMatchObject({ displayCredentials: result.credentials });
  });

  it('preserves stored app-port selection when generating display credentials', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-preserve-app-ports-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    const appPorts = {
      sandboxId: 'sbx-display',
      selected: [5173],
      relays: [{ logicalPort: 5173, relayPort: 45173, label: 'vite' }],
      applied: [6080, 45173],
      fingerprint: 'a'.repeat(64),
      detectorVersion: 2,
      revision: 'b'.repeat(40),
    };
    await store.write({ appPorts });

    await getDisplayCredentials(store);

    await expect(store.read()).resolves.toMatchObject({ appPorts });
  });

  it('keeps a generated credential pending until display startup succeeds', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-pending-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});

    const first = await getDisplayCredentials(store);
    const pending = await getDisplayCredentials(store);

    expect(first.credentials.password).toBe(pending.credentials.password);
    expect(first.generated).toBe(true);
    expect(pending.generated).toBe(true);
    await expect(store.read()).resolves.toMatchObject({
      displayCredentials: {
        username: DISPLAY_USERNAME,
        password: first.credentials.password,
        rotating: true,
      },
    });
  });

  it('converges concurrent missing-field callers on one password', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-concurrent-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});

    const [first, second] = await Promise.all([
      getDisplayCredentials(store),
      getDisplayCredentials(store),
    ]);

    expect(first.credentials).toEqual(second.credentials);
    expect([first.generated, second.generated].sort()).toEqual([true, true]);
  });

  it('prints exactly the two labeled credential lines through the CLI', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-cli-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});
    const runner: ShellRunner = {
      exec: vi.fn(async () => 'git@github.com:Acme/Repo.git'),
      execQuiet: vi.fn(),
      spawnInherit: vi.fn(),
    };
    const provider = createVercelProvider({ stateHome, runner });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutText = '';
    let stderrText = '';
    stdout.on('data', (chunk) => { stdoutText += chunk.toString(); });
    stderr.on('data', (chunk) => { stderrText += chunk.toString(); });

    const code = await dispatch(['--provider', 'vercel', 'feature/display', '--password'], {
      stdin,
      stdout,
      stderr,
    }, {
      repoRoot: '/repo',
      env: {},
      tty: false,
      registry: { ...defaultProviderRegistry, vercel: provider },
    });

    expect(code).toBe(0);
    const stored = await store.read();
    expect(stdoutText).toBe(`username: ${DISPLAY_USERNAME}\npassword: ${stored!.displayCredentials!.password}\n`);
    expect(stderrText).toBe('');
  });

  it('redacts the display password from a provider error', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-redaction-'));
    const remote = 'github.com/acme/repo';
    const branch = 'feature/display';
    const password = generateDisplayPassword();
    const identity = createVercelIdentity({ remote, branch });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const store = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch });
    await scope.write({ teamId: 'team-1', projectId: 'project-1' });
    await store.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      displayCredentials: { username: DISPLAY_USERNAME, password },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const lifecycle = {
      routes: vi.fn(async () => { throw new Error(`proxy failed with ${password}`); }),
    } as unknown as VercelLifecycle;
    const exec = vi.fn(async () => 'git@github.com:Acme/Repo.git');
    const provider = createVercelProvider({
      stateHome,
      runner: {
        exec,
        execQuiet: vi.fn(),
        spawnInherit: vi.fn(),
      },
      lifecycle,
    });

    await expect(provider.url({
      repoRoot: '/repo',
      repoName: 'repo',
      env: {
        VERCEL_TOKEN: 'vercel-token',
        VERCEL_TEAM_ID: 'team-1',
        VERCEL_PROJECT_ID: 'project-1',
      },
      tty: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      branch,
      open: false,
    })).rejects.toEqual(expect.objectContaining({
      message: expect.not.stringContaining(password),
    }));
    expect(exec).toHaveBeenCalledOnce();
  });

  it('redacts the display password from terminal transport errors', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-terminal-redaction-'));
    const remote = 'github.com/acme/repo';
    const branch = 'feature/display';
    const home = await mkdtemp(join(tmpdir(), 'devbox-display-no-pi-'));
    const password = generateDisplayPassword();
    const identity = createVercelIdentity({ remote, branch });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const store = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch });
    await scope.write({ teamId: 'team-1', projectId: 'project-1' });
    await store.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      displayCredentials: { username: DISPLAY_USERNAME, password },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async (_sandbox, options) => {
        options?.onError?.({
          cause: new Error(`WebSocket failed with ${password}`),
          message: `WebSocket failed with ${password}`,
        });
        return { status: 'detached' as const, reason: 'error' as const };
      }),
    };
    const exec = vi.fn(async () => 'git@github.com:Acme/Repo.git');
    const provider = createVercelProvider({
      stateHome,
      runner: {
        exec,
        execQuiet: vi.fn(),
        spawnInherit: vi.fn(),
      },
      lifecycle: {
        attach: vi.fn(async () => ({
          cwd: '/vercel/sandbox',
          name: identity.name,
          currentSession: () => ({ sessionId: identity.name }),
          writeFiles: vi.fn(async () => {}),
          runCommand: vi.fn(async (command: { cmd?: string }) => command.cmd === '/usr/local/bin/devbox-status'
            ? { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT }
            : { exitCode: 0 }),
        }) as unknown as VercelSandboxHandle),
      } as unknown as VercelLifecycle,
      terminal,
    });

    await expect(provider.attach({
      repoRoot: '/repo',
      repoName: 'repo',
      env: {
        HOME: home,
        GH_TOKEN: 'github-runtime-secret',
        VERCEL_TOKEN: 'vercel-token',
        VERCEL_TEAM_ID: 'team-1',
        VERCEL_PROJECT_ID: 'project-1',
      },
      tty: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      branch,
    })).rejects.toEqual(expect.objectContaining({
      message: expect.not.stringContaining(password),
    }));
    expect(exec).toHaveBeenCalledOnce();
  });

  it('redacts cleanup errors before persisting residual metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-cleanup-redaction-'));
    const remote = {
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      canonical: 'github.com/acme/repo',
      url: 'https://github.com/acme/repo.git',
    };
    const branch = 'feature/display';
    const displayPassword = generateDisplayPassword();
    const githubToken = 'github-token';
    const dotenvSecret = 'API_KEY=dotenv-secret';
    const identity = createVercelIdentity({
      remote: remote.canonical,
      branch,
      scope: { teamId: 'team', projectId: 'project' },
    });
    const source: GitHubSourcePlan = {
      remote,
      defaultBranch: 'main',
      requestedBranch: branch,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: {
        type: 'git',
        url: remote.url,
        revision: branch,
        username: 'x-access-token',
        password: githubToken,
      },
      warning: '',
    };
    const handle = {
      name: identity.name,
      status: 'stopped',
      currentSession: () => ({ sessionId: identity.name }),
      image: TEST_IMAGE_REFERENCE,
      persistent: true,
      tags: { ...identity.tags },
      domain: (port: number) => `https://sandbox.example/${port}`,
    } as unknown as VercelSandboxHandle;
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      listSnapshots: vi.fn(async () => [{
        id: 'snapshot-failed',
        sourceSessionId: 'session',
        status: 'failed' as const,
      }]),
      getSnapshot: vi.fn(async () => {
        throw new Error(`cleanup failed ${githubToken} ${dotenvSecret} ${displayPassword}`);
      }),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const store = createVercelBranchMetadataStore({ stateHome, repoKey: remote.canonical, branch });
    await store.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      displayCredentials: { username: DISPLAY_USERNAME, password: displayPassword },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: remote.url,
        sourceRevision: branch,
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const lifecycle = createVercelLifecycle({
      resolveImage: resolveTestImage,
      repoRoot: '/repo',
      branch,
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      env: { GH_TOKEN: dotenvSecret },
      source,
      timeoutMs: 1_800_000,
      branchMetadataStore: store,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await lifecycle.up();
    await expect(lifecycle.remove()).rejects.toMatchObject({ code: 'cleanup_incomplete' });

    const persisted = await readFile(store.path, 'utf8');
    expect(persisted).toContain(displayPassword);
    expect(persisted).not.toContain(githubToken);
    expect(persisted).not.toContain(dotenvSecret);
  });

  it('preserves the display credential in recovered-remove residual metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-recovered-remove-'));
    const remote = {
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      canonical: 'github.com/acme/repo',
      url: 'https://github.com/acme/repo.git',
    };
    const branch = 'feature/display';
    const displayPassword = generateDisplayPassword();
    const identity = createVercelIdentity({
      remote: remote.canonical,
      branch,
      scope: { teamId: 'team', projectId: 'project' },
    });
    const source: GitHubSourcePlan = {
      remote,
      defaultBranch: 'main',
      requestedBranch: branch,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: {
        type: 'git',
        url: remote.url,
        revision: branch,
        username: 'x-access-token',
        password: 'github-token',
      },
      warning: '',
    };
    const handle = {
      name: identity.name,
      status: 'stopped',
      currentSession: () => ({ sessionId: identity.name }),
      image: TEST_IMAGE_REFERENCE,
      persistent: true,
      tags: { ...identity.tags },
      domain: (port: number) => `https://sandbox.example/${port}`,
    } as unknown as VercelSandboxHandle;
    const store = createVercelBranchMetadataStore({ stateHome, repoKey: remote.canonical, branch });
    await store.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      displayCredentials: { username: DISPLAY_USERNAME, password: displayPassword },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: remote.url,
        sourceRevision: branch,
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const client = {
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      listSnapshots: vi.fn(async () => [{
        id: 'snapshot-failed',
        sourceSessionId: 'session',
        status: 'failed' as const,
      }]),
      getSnapshot: vi.fn(async () => { throw new Error('snapshot cleanup blocked'); }),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      resolveImage: resolveTestImage,
      repoRoot: '/repo',
      branch,
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      source,
      branchMetadataStore: store,
      recovery: { identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      } },
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(lifecycle.remove()).rejects.toMatchObject({ code: 'cleanup_incomplete' });
    await expect(store.read()).resolves.toMatchObject({
      displayCredentials: { username: DISPLAY_USERNAME, password: displayPassword },
    });
  });

  it('preserves the display credential when lifecycle metadata is rewritten', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-preserve-'));
    const remote = {
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      canonical: 'github.com/acme/repo',
      url: 'https://github.com/acme/repo.git',
    };
    const branch = 'feature/display';
    const identity = createVercelIdentity({
      remote: remote.canonical,
      branch,
      scope: { teamId: 'team', projectId: 'project' },
    });
    const source: GitHubSourcePlan = {
      remote,
      defaultBranch: 'main',
      requestedBranch: branch,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: {
        type: 'git',
        url: remote.url,
        revision: branch,
        username: 'x-access-token',
        password: 'github-token',
      },
      warning: '',
    };
    const handle = {
      name: identity.name,
      status: 'running',
      currentSession: () => ({ sessionId: identity.name }),
      image: TEST_IMAGE_REFERENCE,
      persistent: true,
      tags: { ...identity.tags },
      domain: (port: number) => `https://sandbox.example/${port}`,
    } as unknown as VercelSandboxHandle;
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
    } as unknown as VercelSandboxClient;
    const store = createVercelBranchMetadataStore({ stateHome, repoKey: remote.canonical, branch });
    const lifecycle = createVercelLifecycle({
      resolveImage: resolveTestImage,
      repoRoot: '/repo',
      branch,
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      source,
      branchMetadataStore: store,
      client,
      ports: [5173],
    });

    await lifecycle.up();
    const first = await getDisplayCredentials(store);
    await lifecycle.stop();
    await expect(store.read()).resolves.toMatchObject({ displayCredentials: first.credentials });
    await lifecycle.up();

    await expect(store.read()).resolves.toMatchObject({ displayCredentials: first.credentials });
  });

  it('preserves the display credential in creation-compensation metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-compensation-'));
    const remote = {
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      canonical: 'github.com/acme/repo',
      url: 'https://github.com/acme/repo.git',
    };
    const branch = 'feature/display';
    const displayPassword = generateDisplayPassword();
    const identity = createVercelIdentity({
      remote: remote.canonical,
      branch,
      scope: { teamId: 'team', projectId: 'project' },
    });
    const source: GitHubSourcePlan = {
      remote,
      defaultBranch: 'main',
      requestedBranch: branch,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: {
        type: 'git',
        url: remote.url,
        revision: branch,
        username: 'x-access-token',
        password: 'github-token',
      },
      warning: '',
    };
    const handle = {
      name: identity.name,
      status: 'stopped',
      currentSession: () => ({ sessionId: identity.name }),
      image: TEST_IMAGE_REFERENCE,
      persistent: true,
      tags: { ...identity.tags },
      domain: (port: number) => `https://sandbox.example/${port}`,
    } as unknown as VercelSandboxHandle;
    const baseStore = createVercelBranchMetadataStore({ stateHome, repoKey: remote.canonical, branch });
    const metadataInput = {
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      displayCredentials: { username: DISPLAY_USERNAME, password: displayPassword },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: remote.url,
        sourceRevision: branch,
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    };
    await baseStore.write(metadataInput);
    let writes = 0;
    const store = {
      ...baseStore,
      write: vi.fn(async (value: Parameters<typeof baseStore.write>[0]) => {
        writes += 1;
        if (writes === 1) throw new Error('metadata persistence failed');
        await baseStore.write(value);
      }),
    };
    const client = {
      getOrCreate: vi.fn(async (request: { onCreate?: (value: VercelSandboxHandle) => Promise<void> }) => {
        await request.onCreate?.(handle);
        return handle;
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      listSnapshots: vi.fn(async () => [{
        id: 'snapshot-failed',
        sourceSessionId: 'session',
        status: 'failed' as const,
      }]),
      getSnapshot: vi.fn(async () => { throw new Error('snapshot cleanup blocked'); }),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      resolveImage: resolveTestImage,
      repoRoot: '/repo',
      branch,
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      source,
      timeoutMs: 1_800_000,
      branchMetadataStore: store,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(lifecycle.up()).rejects.toMatchObject({ code: 'cleanup_incomplete' });
    expect(writes).toBe(2);
    await expect(baseStore.read()).resolves.toMatchObject({
      displayCredentials: { username: DISPLAY_USERNAME, password: displayPassword },
    });
  });

  it('confines the access code to the display link and keeps it out of list and stop output', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-output-'));
    const remote = 'github.com/acme/repo';
    const branch = 'feature/display';
    const home = await mkdtemp(join(tmpdir(), 'devbox-display-no-pi-'));
    const password = generateDisplayPassword();
    const identity = createVercelIdentity({
      remote,
      branch,
      scope: { teamId: 'team-1', projectId: 'project-1' },
    });
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: remote });
    const store = createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch });
    await scope.write({ teamId: 'team-1', projectId: 'project-1' });
    await store.write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      displayCredentials: { username: DISPLAY_USERNAME, password },
      configuration: {
        imageReference: TEST_IMAGE_REFERENCE,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const runCommand = vi.fn(async (command: { cmd?: string }) => command.cmd === '/usr/local/bin/devbox-status'
      ? { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT }
      : { exitCode: 0 });
    const handle = {
      name: identity.name,
      cwd: '/vercel/sandbox',
      status: 'running',
      currentSession: () => ({ sessionId: 'display-credentials-session', runCommand }),
      tags: { ...identity.tags },
      routes: [{ port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' }],
      writeFiles: vi.fn(async () => {}),
      runCommand,
      domain: (port: number) => `https://sandbox.example/${port}`,
    } as unknown as VercelSandboxHandle;
    const lifecycle = {
      up: vi.fn(async () => handle),
      attach: vi.fn(async () => handle),
      stop: vi.fn(async () => ({ name: identity.name, sessions: [] })),
      list: vi.fn(async () => [{ name: identity.name, status: 'running', tags: { ...identity.tags } }]),
      routes: vi.fn(async () => [{ port: 6080, subdomain: 'sandbox', url: 'https://sandbox.example/6080' }]),
    } as unknown as VercelLifecycle;
    const terminal = { attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })) };
    const runner: ShellRunner = {
      exec: vi.fn(async (_command, args) => args[0] === 'remote'
        ? 'git@github.com:Acme/Repo.git'
        : 'ref: refs/heads/main\tHEAD\n'),
      execQuiet: vi.fn(async (_command, args) => args[0] === 'check-ref-format'
        ? { stdout: '', code: 0 }
        : { stdout: `sha\trefs/heads/${branch}\n`, code: 0 }),
      spawnInherit: vi.fn(),
    };
    const provider = createVercelProvider({ stateHome, runner, lifecycle, terminal });
    const env = {
      HOME: home,
      GH_TOKEN: 'github-token',
      VERCEL_TOKEN: 'vercel-token',
      VERCEL_TEAM_ID: 'team-1',
      VERCEL_PROJECT_ID: 'project-1',
    };
    const outputs: Array<() => string> = [];
    const request = (extra: Record<string, unknown> = {}) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let output = '';
      stdout.on('data', (chunk) => { output += chunk.toString(); });
      stderr.on('data', (chunk) => { output += chunk.toString(); });
      outputs.push(() => output);
      return {
        repoRoot: '/repo',
        repoName: 'repo',
        env,
        tty: false,
        stdin: new PassThrough(),
        stdout,
        stderr,
        branch,
        ...extra,
      } as never;
    };

    await provider.list(request());
    await provider.url(request({ open: false }));
    await provider.attach(request());
    await provider.stop(request({ tty: false }));
    await provider.up(request({ tty: true }));

    expect(outputs).toHaveLength(5);
    const [list, url, attach, stop, up] = outputs.map((readOutput) => readOutput());

    // Surfaces that do not offer the display never carry the code.
    for (const output of [list, stop]) expect(output).not.toContain(password);

    // --url prints routes only, so the link is the sole carrier there.
    const urlLines = url.split('\n').filter((line) => line.includes(password));
    expect(urlLines).toHaveLength(1);
    expect(urlLines[0]).toContain(`/vnc.html?token=${password}&autoconnect=1`);

    // Boot and resume additionally list the code on its own line so it can be
    // typed into the pairing form; both carriers are display affordances.
    for (const output of [attach, up]) {
      const carrying = output.split('\n').filter((line) => line.includes(password));
      expect(carrying).toHaveLength(2);
      expect(carrying.some((line) => line.includes(`/vnc.html?token=${password}&autoconnect=1`))).toBe(true);
      expect(carrying.some((line) => line.trim() === `access code: ${password}`)).toBe(true);
    }
  });

  it('advertises Vercel password retrieval and local unsupported behavior', async () => {
    const outputFor = async (args: string[]): Promise<string> => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let output = '';
      stdout.on('data', (chunk) => { output += chunk.toString(); });
      stderr.on('data', (chunk) => { output += chunk.toString(); });
      await dispatch(args, { stdin, stdout, stderr }, { repoRoot: '/repo', tty: false });
      return output;
    };

    const outputs = await Promise.all([
      outputFor(['--help']),
      outputFor(['feature/display', '--help']),
      outputFor(['feature/display', '--password', '--help']),
    ]);

    expect(outputs.join('')).toContain('--password');
    expect(outputs.join('')).toContain('local provider reports this action as unsupported');
  });

  it('generates a short, unambiguous, distinct pairing code', () => {
    const codes = Array.from({ length: 200 }, () => generateDisplayPassword());

    for (const code of codes) {
      // Short enough to read aloud and type into the pairing form; a
      // 43-character base64url secret is not.
      expect(code).toHaveLength(9);
      expect(code).toMatch(DISPLAY_CODE_PATTERN);
      // The alphabet drops I and O and has no 0 or 1, so the pairs that are
      // misread on a screen cannot occur.
      expect(code).not.toMatch(/[0O1I]/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
});
