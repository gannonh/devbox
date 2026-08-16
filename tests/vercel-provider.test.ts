import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { dispatch } from '../src/cli.js';
import { createVercelProvider } from '../src/providers/vercel/provider.js';
import type { DevboxProvider, ProviderBranchRequest } from '../src/providers/types.js';
import type { ShellRunner } from '../src/lib/shell.js';
import type { VercelLifecycle, VercelLifecycleOptions } from '../src/providers/vercel/lifecycle.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import { createVercelMetadataStore } from '../src/providers/vercel/metadata.js';
import { VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
import type { VercelTerminalAdapter } from '../src/providers/vercel/terminal.js';
import type { VercelSandboxHandle } from '../src/providers/vercel/client.js';

function request(overrides: Partial<ProviderBranchRequest> = {}): ProviderBranchRequest {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
    env: {
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
    ...overrides,
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
    cwd: '/vercel/sandbox/repo',
    tags: {},
    openInteractive: vi.fn(),
    extendTimeout: vi.fn(),
    listSessions: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    runCommand: vi.fn(),
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

describe('Vercel provider', () => {
  it('maps provider failures through CLI dispatch without exposing credentials', async () => {
    const token = 'dispatch-vercel-secret';
    const currentLifecycle = lifecycle();
    currentLifecycle.up = vi.fn(async () => {
      throw Object.assign(new Error(`Vercel API body ${token}`), { status: 401 });
    });
    const provider = createVercelProvider({
      runner: runner(),
      stateHome: '/tmp/devbox-provider-dispatch-test',
      lifecycle: currentLifecycle,
      confirmation: vi.fn(async () => true),
    });
    const local = {
      name: 'local',
      up: vi.fn(), attach: vi.fn(), stop: vi.fn(), remove: vi.fn(), list: vi.fn(), url: vi.fn(),
      getDisplayCredentials: vi.fn(),
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

  it('fails first use in a non-TTY before lifecycle creation', async () => {
    const currentLifecycle = lifecycle();
    const provider = createVercelProvider({
      runner: runner(),
      stateHome: '/tmp/devbox-provider-nontty-test',
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

  it('reuses stored scope for attach without a GitHub token or remote branch query', async () => {
    const stateHome = '/tmp/devbox-provider-stored-test';
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const metadata = createVercelMetadataStore({ stateHome, repoKey: remote });
    await metadata.write({
      teamId: 'stored-team',
      projectId: 'stored-project',
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      sandboxId: 'sandbox-id',
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
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
    expect(confirmation).not.toHaveBeenCalled();
    expect(execQuiet).not.toHaveBeenCalled();
  });

  it('renders only concise stop usage output', async () => {
    const stateHome = '/tmp/devbox-provider-stop-test';
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const metadata = createVercelMetadataStore({ stateHome, repoKey: remote });
    await metadata.write({
      teamId: 'stored-team',
      projectId: 'stored-project',
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
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
      runner: shell,
      stateHome,
      lifecycle: currentLifecycle,
    });

    await expect(provider.stop(request({
      env: { VERCEL_TOKEN: 'new-vercel-token' },
      stderr,
      tty: false,
    }))).resolves.toEqual({ exitCode: 0 });

    expect(output).toContain(`${identity.name}: stopped`);
    expect(output).toContain('snapshot: snapshot-1 created');
    expect(output).toContain('cpu: 123ms');
    expect(output).toContain('network: ingress=4 egress=5');
    expect(output).not.toContain('session');
    expect(output).not.toContain('new-vercel-token');
  });

  it('routes list, URL/open, and remove through stored metadata without remote queries', async () => {
    const stateHome = '/tmp/devbox-provider-actions-test';
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const metadata = createVercelMetadataStore({ stateHome, repoKey: remote });
    await metadata.write({
      teamId: 'stored-team',
      projectId: 'stored-project',
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
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
    expect(urls.join('')).toBe('3000: https://sandbox.example/3000\n8080: https://sandbox.example/8080\n');
    expect(opener).toHaveBeenCalledWith('https://sandbox.example/3000');
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
    const terminal = { attach: vi.fn(async () => ({ status: 'exited' as const, code: 23 })) } as VercelTerminalAdapter;
    const provider = createVercelProvider({
      runner: runner(),
      stateHome: '/tmp/devbox-provider-terminal-result-test',
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

  it('reuses stored scope on up without reconfirming an existing sandbox', async () => {
    const stateHome = '/tmp/devbox-provider-up-existing-test';
    const remote = 'github.com/acme/repo';
    const identity = createVercelIdentity({ remote, branch: 'feature/ui', packageVersion: '0.1.2' });
    const metadata = createVercelMetadataStore({ stateHome, repoKey: remote });
    await metadata.write({
      teamId: 'stored-team',
      projectId: 'stored-project',
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
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

  it('confirms first-use scope before creating and attaches a terminal in sandbox cwd', async () => {
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
      runner: runner(),
      stateHome: '/tmp/devbox-provider-test',
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
      expect.objectContaining({ cwd: '/vercel/sandbox/repo' }),
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
