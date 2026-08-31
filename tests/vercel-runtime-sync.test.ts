import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
  VercelWriteFile,
} from '../src/providers/vercel/client.js';
import type { ShellRunner } from '../src/lib/shell.js';
import { createVercelProvider } from '../src/providers/vercel/provider.js';
import type { ProviderBranchRequest } from '../src/providers/types.js';
import type { VercelLifecycle } from '../src/providers/vercel/lifecycle.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import { createVercelBranchMetadataStore, createVercelScopeMetadataStore } from '../src/providers/vercel/metadata.js';
import type { VercelTerminalAdapter } from '../src/providers/vercel/terminal.js';
import { prepareSandboxRuntime } from '../src/providers/vercel/runtime.js';
import { DISPLAY_STATUS_OUTPUT } from './vercel-display-status.fixture.js';
import { TEST_IMAGE_REFERENCE } from './vercel-image.fixture.js';

function sandbox(): VercelSandboxHandle {
  return {
    name: 'runtime-sync',
    status: 'running',
    cwd: '/vercel/sandbox',
    currentSession: () => ({ sessionId: 'runtime-sync' }),
  } as unknown as VercelSandboxHandle;
}

function runner(): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
  };
}

function client(): {
  client: VercelSandboxClient;
  uploads: VercelWriteFile[][];
  commands: VercelRunCommandRequest[];
} {
  const uploads: VercelWriteFile[][] = [];
  const commands: VercelRunCommandRequest[] = [];
  return {
    uploads,
    commands,
    client: {
      writeFiles: vi.fn(async (_sandbox, files) => { uploads.push(files); }),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient,
  };
}

function tokenTrackingClient(authExitCode: number): {
  client: VercelSandboxClient;
  commands: VercelRunCommandRequest[];
  tokenFilePresent: () => boolean;
} {
  const tokenPath = '/vercel/.devbox/runtime/github-token';
  const commands: VercelRunCommandRequest[] = [];
  let tokenFilePresent = false;
  return {
    commands,
    tokenFilePresent: () => tokenFilePresent,
    client: {
      writeFiles: vi.fn(async (_sandbox: VercelSandboxHandle, files: VercelWriteFile[]) => {
        if (files.some((file) => file.path === tokenPath)) tokenFilePresent = true;
      }),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
        commands.push(request);
        const script = request.args?.[1] ?? '';
        if (script.includes('gh auth login')) {
          if (authExitCode === 0 && script.includes(`rm -f ${tokenPath}`)) tokenFilePresent = false;
          return { exitCode: authExitCode };
        }
        if (script === `rm -f ${tokenPath}`) tokenFilePresent = false;
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient,
  };
}

describe('Vercel runtime sync', () => {
  it('injects selected dotenv values into private runtime state', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-env-'));
    const envPath = join(hostEnv, '.env');
    await writeFile(envPath, 'API_PASSWORD=dotenv-secret\nPORT=5173\n');
    const fake = client();

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(hostEnv, 'missing-pi'),
    });

    expect(fake.uploads.flat()).toContainEqual({
      path: '/vercel/.devbox/runtime/environment.json',
      content: Buffer.from(JSON.stringify({ API_PASSWORD: 'dotenv-secret', PORT: '5173' })),
      mode: 0o600,
    });
    expect(fake.commands.some((command) => command.env?.API_PASSWORD === 'dotenv-secret')).toBe(true);
    expect(fake.uploads.flat().some((file) => file.path === '/vercel/.env')).toBe(false);
  });

  it('rejects unsafe keys in directly supplied runtime environments', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-env-keys-'));
    for (const key of ['BAD$(id)', 'BASH_ENV']) {
      await expect(prepareSandboxRuntime({
        repoRoot: '/host/repo',
        repository: 'repo',
        env: { GH_TOKEN: 'github-secret' },
        runtimeEnvironment: { [key]: 'dummy' },
        shellRunner: runner(),
        sandbox: sandbox(),
        client: client().client,
        stderr: new PassThrough(),
        piRoot: join(hostEnv, 'missing-pi'),
      })).rejects.toThrow('invalid variable name');
    }
    await rm(hostEnv, { recursive: true, force: true });
  });

  it('reuses stored runtime state when no env override is provided', async () => {
    const fake = client();
    const runCommand = fake.client.runCommand as unknown as ReturnType<typeof vi.fn>;
    runCommand.mockImplementation(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      fake.commands.push(request);
      if (request.args?.[1]?.includes('if [ -f /vercel/.devbox/runtime/environment.json')) {
        return { exitCode: 0, stdout: async () => JSON.stringify({ API_KEY: 'persisted-secret' }) };
      }
      return { exitCode: 0 };
    });

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(tmpdir(), 'missing-pi'),
    });

    expect(fake.commands.some((command) => command.env?.API_KEY === 'persisted-secret')).toBe(true);
    expect(fake.uploads.flat().some((file) => file.path === '/vercel/.devbox/runtime/environment.json')).toBe(false);
  });

  it('uses an empty runtime environment when no stored state exists', async () => {
    const fake = client();
    const runCommand = fake.client.runCommand as unknown as ReturnType<typeof vi.fn>;
    runCommand.mockImplementation(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      fake.commands.push(request);
      if (request.args?.[1]?.includes('if [ -f /vercel/.devbox/runtime/environment.json')) {
        const stdout = request.args[1].includes("else printf '{}'; fi") ? '{}' : '';
        return { exitCode: 0, stdout: async () => stdout };
      }
      return { exitCode: 0 };
    });

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(tmpdir(), 'missing-pi'),
    });

    const stateReadCommand = fake.commands.find((command) =>
      command.cmd === 'sh'
      && command.args?.[0] === '-c'
      && command.args?.[1]?.includes('/vercel/.devbox/runtime/environment.json'),
    );
    expect(stateReadCommand).toBeDefined();
    expect(stateReadCommand?.args?.[1] ?? '').toContain("else printf '{}'; fi");
    expect(fake.commands.every((command) => Object.keys(command.env ?? {}).length === 0)).toBe(true);
  });

  it('fails when the selected env file is missing', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-missing-env-'));
    const envPath = join(hostEnv, '.env');
    const fake = client();

    await expect(prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(hostEnv, 'missing-pi'),
    })).rejects.toThrow(`unable to read env file ${envPath}`);
    expect(fake.uploads).toEqual([]);
  });

  it('does not create a dotenv file in the remote checkout', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-link-'));
    const envPath = join(hostEnv, '.env');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const fake = client();

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(hostEnv, 'missing-pi'),
    });

    expect(fake.commands.some((command) => command.args?.some((arg) => arg.includes('.env')))).toBe(false);
  });

  it('authenticates gh and git from a 0600 token file without putting the token in argv', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-github-'));
    const envPath = join(hostEnv, '.env');
    const token = 'github-runtime-secret';
    await writeFile(envPath, 'API_PASSWORD=dotenv-secret\n');
    const fake = client();

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: token },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(hostEnv, 'missing-pi'),
    });

    expect(fake.uploads.flat()).toContainEqual({
      path: '/vercel/.devbox/runtime/github-token',
      content: Buffer.from(token),
      mode: 0o600,
    });
    const authCommand = fake.commands.find((command) => command.args?.[1]?.includes('gh auth login'));
    expect(authCommand).toMatchObject({
      cmd: 'sh',
      args: [
        '-c',
        expect.stringContaining('gh auth login --hostname github.com --with-token < /vercel/.devbox/runtime/github-token'),
      ],
    });
    expect(authCommand?.args).toEqual(expect.arrayContaining([
      expect.stringContaining('gh auth setup-git --hostname github.com'),
    ]));
    expect(authCommand?.env).toEqual({ API_PASSWORD: 'dotenv-secret' });
    expect(fake.commands.find((command) => command.cmd === 'mkdir')?.args)
      .toEqual(expect.arrayContaining(['/vercel/.config/gh']));
    expect(JSON.stringify(fake.commands)).not.toContain(token);
    expect(fake.uploads.flat().every((file) => !file.path.startsWith('/vercel/sandbox/repo'))).toBe(true);
  });

  it('reconciles remote Pi config while preserving box-only runtime subtrees', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-pi-reconcile-'));
    const envPath = join(hostEnv, '.env');
    const remotePi = new Set([
      '/vercel/.pi/stale.json',
      '/vercel/.pi/agent/stale.json',
      '/vercel/.pi/agent/npm/package.json',
    ]);
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const fake = client();
    const runCommand = fake.client.runCommand as unknown as ReturnType<typeof vi.fn>;
    runCommand.mockImplementation(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      if (request.args?.[1]?.includes('find /vercel/.pi')) {
        remotePi.delete('/vercel/.pi/stale.json');
        remotePi.delete('/vercel/.pi/agent/stale.json');
      }
      fake.commands.push(request);
      return { exitCode: 0 };
    });

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(hostEnv, 'missing-pi'),
    });

    expect(remotePi).not.toContain('/vercel/.pi/stale.json');
    expect(remotePi).not.toContain('/vercel/.pi/agent/stale.json');
    expect(remotePi).toContain('/vercel/.pi/agent/npm/package.json');
    const reconciliation = fake.commands.find((command) => command.args?.[1]?.includes('find /vercel/.pi'));
    expect(reconciliation?.args?.[1]).toContain('! -name agent');
    expect(reconciliation?.args?.[1]).toContain('! -name sessions ! -name npm ! -name cache ! -name fff');
  });

  it('removes the raw GitHub token file after successful authentication', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-github-cleanup-'));
    const envPath = join(hostEnv, '.env');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const fake = tokenTrackingClient(0);

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(hostEnv, 'missing-pi'),
    });

    expect(fake.tokenFilePresent()).toBe(false);
    expect(fake.commands.find((command) => command.args?.[1]?.includes('gh auth login'))?.args?.[1])
      .toContain('&& rm -f /vercel/.devbox/runtime/github-token');
  });

  it('removes the raw GitHub token file after authentication failure', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-github-failure-cleanup-'));
    const envPath = join(hostEnv, '.env');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const fake = tokenTrackingClient(1);

    await expect(prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot: join(hostEnv, 'missing-pi'),
    })).rejects.toThrow(/GitHub auth setup failed/);

    expect(fake.tokenFilePresent()).toBe(false);
    expect(fake.commands.some((command) => command.args?.[1] === 'rm -f /vercel/.devbox/runtime/github-token')).toBe(true);
  });

  it('uploads filtered Pi files under ~/.pi without group or other write bits', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-pi-'));
    const envPath = join(hostEnv, '.env');
    const piRoot = join(hostEnv, 'pi');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    await mkdir(join(piRoot, 'agent'), { recursive: true });
    const piFile = join(piRoot, 'agent', 'settings.json');
    await writeFile(piFile, '{"packages":[]}');
    await chmod(piFile, 0o776);
    const fake = client();

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot,
    });

    expect(fake.uploads.flat()).toContainEqual({
      path: '/vercel/.pi/agent/settings.json',
      content: Buffer.from('{"packages":[]}'),
      mode: 0o754,
    });
    expect(fake.commands).toContainEqual(expect.objectContaining({
      cmd: 'mkdir',
      args: ['-p', '/vercel/.devbox', '/vercel/.devbox/runtime', '/vercel/.config', '/vercel/.config/gh', '/vercel/.pi', '/vercel/.pi/agent'],
      env: { API_KEY: 'dotenv-secret' },
    }));
    expect(fake.commands).toContainEqual(expect.objectContaining({
      cmd: 'chmod',
      args: ['700', '/vercel/.devbox', '/vercel/.devbox/runtime', '/vercel/.config', '/vercel/.config/gh', '/vercel/.pi', '/vercel/.pi/agent'],
      env: { API_KEY: 'dotenv-secret' },
    }));
  });

  it('warns and continues when the host Pi root is missing', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-pi-missing-'));
    const envPath = join(hostEnv, '.env');
    const piRoot = join(hostEnv, 'missing-pi');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const fake = client();
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: {
        GH_TOKEN: 'github-secret',
        PWD: piRoot,
        SHELL: '/bin/bash',
      },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr,
      piRoot,
    });

    expect(output).toContain(`Pi config root missing at ${piRoot}`);
    expect(fake.uploads.flat().some((file) => file.path.startsWith('/vercel/.pi/'))).toBe(false);
  });

  it('reports Pi exclusions as paths and reasons without uploading escaped content', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-pi-exclusion-'));
    const envPath = join(hostEnv, '.env');
    const piRoot = join(hostEnv, 'pi');
    const outside = join(hostEnv, 'outside-secret.txt');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    await mkdir(piRoot);
    await writeFile(outside, 'pi-password-secret');
    await symlink(outside, join(piRoot, 'escape.txt'));
    const fake = client();
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr,
      piRoot,
    });

    expect(output).toContain('Pi config skipped escape.txt: symlink resolves outside Pi root');
    expect(output).not.toContain('pi-password-secret');
    expect(fake.uploads.flat().some((file) => file.path.endsWith('/escape.txt'))).toBe(false);
  });

  it('aborts Pi limit failures before any sandbox upload', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-pi-limit-'));
    const envPath = join(hostEnv, '.env');
    const piRoot = join(hostEnv, 'pi');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    await mkdir(piRoot);
    await writeFile(join(piRoot, 'too-large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const fake = client();

    await expect(prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fake.client,
      stderr: new PassThrough(),
      piRoot,
    })).rejects.toThrow(/maximum of 4194304 bytes/);
    expect(fake.uploads).toEqual([]);
    expect(fake.commands).toEqual([]);
  });

  function isNonRuntimeCommand(request: VercelRunCommandRequest): boolean {
    const args = (request.args ?? []).join(' ');
    return (request.cmd === 'git' && args === 'rev-parse HEAD')
      || args.includes('package.json')
      || args.includes('/tmp/devbox-tmux');
  }

  it('runs runtime sync on up before terminal readiness', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-provider-up-'));
    const envPath = join(hostEnv, '.env');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const events: string[] = [];
    const runtimeSignals: AbortSignal[] = [];
    const handle = sandbox();
    const branchMetadata = createVercelBranchMetadataStore({
      stateHome: hostEnv,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/ui',
    });
    await branchMetadata.write({});
    const lifecycle = {
      up: vi.fn(async () => {
        events.push('lifecycle-up');
        return handle;
      }),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async (_sandbox, _files, options) => {
        if (options?.signal) runtimeSignals.push(options.signal);
        events.push('runtime-upload');
      }),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
        // App-port scanning and terminal-shell setup use independent deadlines,
        // so exclude them from the shared runtime-signal assertion.
        if (request.signal && !isNonRuntimeCommand(request)) runtimeSignals.push(request.signal);
        events.push('runtime-command');
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => {
        events.push('terminal-attach');
        return { status: 'detached' as const, reason: 'escape' as const };
      }),
    };
    const sourceRunner: ShellRunner = {
      exec: vi.fn(async (_command, args) => {
        if (args[0] === 'remote') return 'git@github.com:Acme/Repo.git';
        if (args[0] === 'ls-remote' && args.includes('--symref')) return 'ref: refs/heads/main\tHEAD\n';
        throw new Error(`unexpected exec: ${args.join(' ')}`);
      }),
      execQuiet: vi.fn(async (_command, args) => args[0] === 'check-ref-format'
        ? { stdout: '', code: 0 }
        : { stdout: 'sha\trefs/heads/main\n', code: 0 }),
      spawnInherit: vi.fn(),
    };
    const request: ProviderBranchRequest = {
      repoRoot: '/host/repo',
      repoName: 'repo',
      env: {
        HOME: hostEnv,
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'vercel-secret',
        VERCEL_TEAM_ID: 'team-1',
        VERCEL_PROJECT_ID: 'project-1',
      },
      envPath,
      tty: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      branch: 'feature/ui',
    };
    const provider = createVercelProvider({
      runner: sourceRunner,
      lifecycle,
      client,
      terminal,
      confirmation: vi.fn(async () => true),
      stateHome: hostEnv,
    });

    await expect(provider.up(request)).resolves.toEqual({ exitCode: 0 });

    expect(events.indexOf('lifecycle-up')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('runtime-upload')).toBeGreaterThan(events.indexOf('lifecycle-up'));
    expect(events.indexOf('terminal-attach')).toBeGreaterThan(events.indexOf('runtime-upload'));
    expect(runtimeSignals.length).toBeGreaterThan(0);
    expect(new Set(runtimeSignals)).toHaveLength(1);
  });

  it('serializes concurrent runtime preparation for one branch sandbox', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-provider-lock-'));
    const branch = 'feature/ui';
    const branchMetadata = createVercelBranchMetadataStore({
      stateHome: hostEnv,
      repoKey: 'github.com/acme/repo',
      branch,
    });
    await branchMetadata.write({
      displayCredentials: { username: 'devbox', password: 'display-secret' },
    });
    let runtimeStarts = 0;
    let releaseFirstRuntime!: () => void;
    const firstRuntimeGate = new Promise<void>((resolve) => { releaseFirstRuntime = resolve; });
    const lifecycle = {
      up: vi.fn(async () => sandbox()),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
        if (request.args?.[1]?.includes('/vercel/.devbox/runtime/preparation.json')) {
          runtimeStarts += 1;
          if (runtimeStarts === 1) await firstRuntimeGate;
        }
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const sourceRunner: ShellRunner = {
      exec: vi.fn(async (_command, args) => {
        if (args[0] === 'remote') return 'git@github.com:Acme/Repo.git';
        if (args[0] === 'ls-remote' && args.includes('--symref')) return 'ref: refs/heads/main\tHEAD\n';
        throw new Error(`unexpected exec: ${args.join(' ')}`);
      }),
      execQuiet: vi.fn(async () => ({ stdout: '', code: 0 })),
      spawnInherit: vi.fn(),
    };
    const provider = createVercelProvider({
      runner: sourceRunner,
      lifecycle,
      client,
      terminal,
      confirmation: vi.fn(async () => true),
      stateHome: hostEnv,
    });
    const makeRequest = (): ProviderBranchRequest => ({
      repoRoot: '/host/repo',
      repoName: 'repo',
      env: {
        HOME: hostEnv,
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'vercel-secret',
        VERCEL_TEAM_ID: 'team-1',
        VERCEL_PROJECT_ID: 'project-1',
      },
      tty: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      branch,
    });

    const first = provider.up(makeRequest());
    await vi.waitFor(() => expect(runtimeStarts).toBe(1));
    const second = provider.up(makeRequest());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtimeStarts).toBe(1);
    releaseFirstRuntime();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { exitCode: 0 },
      { exitCode: 0 },
    ]);
    expect(runtimeStarts).toBe(2);
  });

  it('runs runtime sync on attach before terminal readiness', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-provider-attach-'));
    const envPath = join(hostEnv, '.env');
    const remote = 'github.com/acme/repo';
    const branch = 'feature/ui';
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const identity = createVercelIdentity({ remote, branch, scope: { teamId: 'team-1', projectId: 'project-1' } });
    const scope = createVercelScopeMetadataStore({ stateHome: hostEnv, repoKey: remote });
    const metadata = createVercelBranchMetadataStore({ stateHome: hostEnv, repoKey: remote, branch });
    await scope.write({ teamId: 'team-1', projectId: 'project-1' });
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
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    const events: string[] = [];
    const lifecycle = {
      attach: vi.fn(async () => {
        events.push('lifecycle-attach');
        return sandbox();
      }),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => { events.push('runtime-upload'); }),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
        events.push('runtime-command');
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => DISPLAY_STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => {
        events.push('terminal-attach');
        return { status: 'detached' as const, reason: 'escape' as const };
      }),
    };
    const sourceRunner: ShellRunner = {
      exec: vi.fn(async () => 'git@github.com:Acme/Repo.git'),
      execQuiet: vi.fn(),
      spawnInherit: vi.fn(),
    };
    const provider = createVercelProvider({
      runner: sourceRunner,
      lifecycle,
      client,
      terminal,
      stateHome: hostEnv,
    });

    await expect(provider.attach({
      repoRoot: '/host/repo',
      repoName: 'repo',
      env: {
        HOME: hostEnv,
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'vercel-secret',
      },
      envPath,
      tty: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      branch,
    })).resolves.toEqual({ exitCode: 0 });

    expect(events.indexOf('lifecycle-attach')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('runtime-upload')).toBeGreaterThan(events.indexOf('lifecycle-attach'));
    expect(events.indexOf('terminal-attach')).toBeGreaterThan(events.indexOf('runtime-upload'));
    expect(JSON.stringify(await metadata.read())).not.toContain('github-secret');
    expect(JSON.stringify(await metadata.read())).not.toContain('dotenv-secret');
  });

  it('does not surface Pi passwords from file-upload errors', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-pi-redaction-'));
    const envPath = join(hostEnv, '.env');
    const piRoot = join(hostEnv, 'pi');
    const piPassword = 'pi-password-runtime-secret';
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    await mkdir(piRoot);
    await writeFile(join(piRoot, 'auth.json'), `{"password":"${piPassword}"}`);
    const fakeClient = {
      writeFiles: vi.fn(async () => {
        throw Object.assign(new Error(`upload failed ${piPassword}`), {
          operation: 'Sandbox.writeFiles',
          status: 413,
        });
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as VercelSandboxClient;

    const error = await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-secret' },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fakeClient,
      stderr: new PassThrough(),
      piRoot,
    }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('Sandbox.writeFiles');
    expect(String(error)).toContain('status 413');
    expect(String(error)).not.toContain(piPassword);
  });

  it('redacts token and dotenv values from command failures and normal output', async () => {
    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-runtime-redaction-'));
    const envPath = join(hostEnv, '.env');
    const token = 'github-runtime-error-secret';
    const quotedValue = 'dotenv-quoted-runtime-error-secret';
    const commentedValue = 'dotenv-commented-runtime-error-secret';
    const plainValue = 'dotenv-plain-runtime-error-secret';
    await writeFile(
      envPath,
      `QUOTED="${quotedValue}"\nCOMMENTED=${commentedValue} # comment\nPLAIN=${plainValue}\nSHORT=abc12\n`,
    );
    const uploads: VercelWriteFile[][] = [];
    const commands: VercelRunCommandRequest[] = [];
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });
    const fakeClient = {
      writeFiles: vi.fn(async (_sandbox: VercelSandboxHandle, files: VercelWriteFile[]) => {
        uploads.push(files);
      }),
      runCommand: vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
        commands.push(request);
        const auth = request.args?.[1]?.includes('gh auth login') ?? false;
        return {
          exitCode: auth ? 1 : 0,
          stdout: async () => `stdout ${token} ${quotedValue} ${commentedValue} ${plainValue} status=1`,
          stderr: async () => `stderr ${token} ${quotedValue} ${commentedValue} ${plainValue} status=1`,
        };
      }),
    } as unknown as VercelSandboxClient;

    const error = await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: token },
      envPath,
      shellRunner: runner(),
      sandbox: sandbox(),
      client: fakeClient,
      stderr,
      piRoot: join(hostEnv, 'missing-pi'),
    }).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(quotedValue);
    expect(String(error)).not.toContain(commentedValue);
    expect(String(error)).not.toContain(plainValue);
    expect(String(error)).not.toContain('abc12');
    expect(String(error)).toContain('status=1');
    expect(output).not.toContain(token);
    expect(output).not.toContain(quotedValue);
    expect(output).not.toContain(commentedValue);
    expect(output).not.toContain(plainValue);
    expect(output).not.toContain('abc12');
    expect(JSON.stringify(commands)).not.toContain(token);
    expect(uploads[0][1]).toMatchObject({ path: '/vercel/.devbox/runtime/github-token', mode: 0o600 });
    expect(uploads[0][1].content).toEqual(Buffer.from(token));
  });
});
