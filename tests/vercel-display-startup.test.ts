import { mkdtemp, readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DISPLAY_STARTUP_TIMEOUT_MS,
  startDisplayStack,
} from '../src/providers/vercel/display-startup.js';
import {
  DEVBOX_NOVNC_INTERNAL_PORT,
  DEVBOX_NOVNC_PROXY_PORT,
} from '../src/providers/vercel/ports.js';
import { DISPLAY_USERNAME } from '../src/providers/vercel/display-credentials.js';
import {
  createVercelBranchMetadataStore,
  createVercelScopeMetadataStore,
} from '../src/providers/vercel/metadata.js';
import { createVercelProvider } from '../src/providers/vercel/provider.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import { prepareSandboxRuntime } from '../src/providers/vercel/runtime.js';
import type {
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
} from '../src/providers/vercel/client.js';
import type { ShellRunner } from '../src/lib/shell.js';
import type { ProviderBranchRequest } from '../src/providers/types.js';
import type { VercelLifecycle } from '../src/providers/vercel/lifecycle.js';
import type { VercelTerminalAdapter } from '../src/providers/vercel/terminal.js';
import { DISPLAY_STATUS_OUTPUT as STATUS_OUTPUT } from './vercel-display-status.fixture.js';
import { TEST_IMAGE_REFERENCE } from './vercel-image.fixture.js';

function sandbox(): VercelSandboxHandle {
  return {
    name: 'display-startup',
    status: 'running',
    cwd: '/vercel/sandbox',
  } as unknown as VercelSandboxHandle;
}

describe('Vercel display startup', () => {
  it('starts authenticated noVNC on public 6080 with websockify internal on 6081', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-startup-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});
    const uploads: Array<Array<{ path: string; content: Buffer }>> = [];
    const commands: VercelRunCommandRequest[] = [];
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async (_sandbox, files) => { uploads.push(files); }),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => '[devbox-status] display=running\n' };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const secrets: string[] = ['devbox'];

    await startDisplayStack({
      sandbox: sandbox(),
      client,
      store,
      secrets,
    });

    const start = commands.find((request) => request.cmd === '/usr/local/bin/devbox-start');
    const [proxyOverlay, statusOverlay] = uploads[0] as Array<{ path: string; content: Buffer }>;
    expect(proxyOverlay.path).toBe('/vercel/.devbox/runtime/novnc-proxy.mjs');
    expect(proxyOverlay.content.equals(await readFile('images/vercel/novnc-proxy.mjs'))).toBe(true);
    expect(statusOverlay.path).toBe('/vercel/.devbox/runtime/status-devbox.sh');
    expect(statusOverlay.content.equals(await readFile('images/vercel/status-devbox.sh'))).toBe(true);
    expect(commands[0]).toMatchObject({
      cmd: 'sudo',
      args: ['-n', 'sh', '-c', expect.stringContaining("cp '/vercel/.devbox/runtime/novnc-proxy.mjs' '/usr/local/lib/devbox/novnc-proxy.mjs'")],
    });
    expect(commands[0]?.args?.[3]).toContain(
      "cp '/vercel/.devbox/runtime/status-devbox.sh' \"${status_tmp}\"",
    );
    expect(commands[0]?.args?.[3]).toContain('chmod 0755 "${status_tmp}"');
    expect(commands[0]?.args?.[3]).toContain('mv -f "${status_tmp}" \'/usr/local/bin/devbox-status\'');
    expect(start).toMatchObject({
      cmd: '/usr/local/bin/devbox-start',
      env: {
        DEVBOX_NOVNC_PASSWORD: expect.any(String),
        DEVBOX_NOVNC_PORT: String(DEVBOX_NOVNC_PROXY_PORT),
        DEVBOX_NOVNC_INTERNAL_PORT: String(DEVBOX_NOVNC_INTERNAL_PORT),
      },
    });
    expect(Object.keys(start?.env ?? {}).sort()).toEqual([
      'DEVBOX_NOVNC_INTERNAL_PORT',
      'DEVBOX_NOVNC_PASSWORD',
      'DEVBOX_NOVNC_PORT',
    ]);
    expect(start?.env?.DEVBOX_NOVNC_PASSWORD).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(start?.args).toBeUndefined();
    expect('detached' in (start ?? {})).toBe(false);
    expect(start?.timeoutMs).toBe(DISPLAY_STARTUP_TIMEOUT_MS);
    expect(start?.cmd).not.toContain(start?.env?.DEVBOX_NOVNC_PASSWORD ?? '');
    expect(start?.args ?? []).not.toContain(start?.env?.DEVBOX_NOVNC_PASSWORD);
    expect(secrets).toContain(start?.env?.DEVBOX_NOVNC_PASSWORD);
    expect(commands.at(-1)).toMatchObject({
      cmd: '/usr/local/bin/devbox-status',
      env: { DEVBOX_STATUS_MODE: 'display' },
    });
  });

  it('clears the pending rotation marker after successful startup', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-rotation-clear-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => request.cmd === '/usr/local/bin/devbox-status'
        ? { exitCode: 0, stdout: async () => STATUS_OUTPUT }
        : { exitCode: 0 }),
    } as unknown as VercelSandboxClient;

    await startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] });

    const metadata = await store.read();
    expect(metadata?.displayCredentials).toMatchObject({ username: DISPLAY_USERNAME });
    expect(metadata?.displayCredentials).not.toHaveProperty('rotating');
  });

  it('resets display services before startup when the credential rotates', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-rotation-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});
    const commands: VercelRunCommandRequest[] = [];
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await startDisplayStack({
      sandbox: sandbox(),
      client,
      store,
      secrets: [],
    });

    const reset = commands.find((request) => request.cmd === 'sh');
    expect(reset).toMatchObject({ cmd: 'sh', args: ['-c', expect.stringContaining('kill')] });
    expect(reset?.env).toBeUndefined();
    expect(commands[commands.indexOf(reset!) + 1]?.cmd).toBe('/usr/local/bin/devbox-start');
    expect(reset?.args?.join(' ')).toContain('devbox');
    expect(JSON.stringify(reset)).not.toContain('DEVBOX_NOVNC_PASSWORD');
  });

  it('does not start with a rotated credential when service reset fails', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-reset-failure-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});
    const commands: VercelRunCommandRequest[] = [];
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        if (request.cmd === 'sh') return { exitCode: 1, stderr: async () => 'reset failed' };
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    const error = await startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'display_startup_failed',
      message: expect.stringContaining('display service reset failed'),
    });
    expect(commands.some((request) => request.cmd === '/usr/local/bin/devbox-start')).toBe(false);
  });

  it('retries a failed rotation with the same pending password and reset', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-rotation-retry-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});
    const commands: VercelRunCommandRequest[] = [];
    let failStart = true;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT };
        }
        if (request.cmd === '/usr/local/bin/devbox-start' && failStart) {
          return { exitCode: 1, stderr: async () => 'start failed' };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await expect(startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] })).rejects.toThrow(
      'display startup failed',
    );
    const firstPassword = commands.find((request) => request.cmd === '/usr/local/bin/devbox-start')?.env?.DEVBOX_NOVNC_PASSWORD;
    expect(firstPassword).toBeTruthy();
    await expect(store.read()).resolves.toMatchObject({ displayCredentials: { password: firstPassword, rotating: true } });

    failStart = false;
    await startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] });

    const starts = commands.filter((request) => request.cmd === '/usr/local/bin/devbox-start');
    expect(starts).toHaveLength(2);
    expect(starts.every((request) => request.env?.DEVBOX_NOVNC_PASSWORD === firstPassword)).toBe(true);
    expect(commands.filter((request) => request.cmd === 'sh')).toHaveLength(2);
    await expect(store.read()).resolves.toMatchObject({ displayCredentials: { password: firstPassword } });
    expect((await store.read())?.displayCredentials).not.toHaveProperty('rotating');
  });

  it('orders reset kills, bounded waits, X cleanup, and pidfile removal', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-reset-order-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({});
    const commands: VercelRunCommandRequest[] = [];
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] });

    const script = commands.find((request) => request.cmd === 'sh')?.args?.[1] ?? '';
    expect(script).toContain('proc_start_time()');
    expect(script).toContain('expected_command()');
    expect(script).toContain('process_matches()');
    expect(script).toContain('recorded');
    expect(script).toContain('kill -TERM "${pid}"');
    expect(script).toContain('for attempt in $(seq 1 50); do');
    expect(script).toContain('kill -0 "${pid}"');
    expect(script).toContain('display="${DISPLAY:-:99}"');
    expect(script).toContain('rm -f "${tmp_dir}/.X11-unix/X${display_number}" "${tmp_dir}/.X${display_number}-lock"');
    expect(script.indexOf('kill -TERM "${pid}"')).toBeLessThan(script.indexOf('for attempt in $(seq 1 50); do'));
    expect(script.indexOf('for attempt in $(seq 1 50); do')).toBeLessThan(script.indexOf('rm -f "${tmp_dir}/.X11-unix'));
    expect(script.indexOf('rm -f "${tmp_dir}/.X11-unix')).toBeLessThan(script.lastIndexOf('rm -f "${pid_dir}/${service}.pid"'));
  });

  it('replays an existing credential without resetting a live display proxy', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-idempotent-'));
    const password = 'existing-display-password';
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({ displayCredentials: { username: DISPLAY_USERNAME, password } });
    const commands: VercelRunCommandRequest[] = [];
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] });
    await startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] });

    expect(commands.filter((request) => request.cmd === 'sh')).toHaveLength(0);
    expect(commands.filter((request) => request.cmd === '/usr/local/bin/devbox-start')).toHaveLength(2);
    expect(commands.filter((request) => request.cmd === '/usr/local/bin/devbox-start')
      .every((request) => request.env?.DEVBOX_NOVNC_PASSWORD === password)).toBe(true);
  });

  it('reports the stopped service and redacts the display password when readiness fails', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-status-failure-'));
    const password = 'status-display-password';
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({ displayCredentials: { username: DISPLAY_USERNAME, password } });
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return {
            exitCode: 1,
            stdout: async () => `${STATUS_OUTPUT.replace('auth-proxy=running', 'auth-proxy=stopped')} ${password}`,
          };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    const error = await startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'display_startup_failed',
      message: expect.stringContaining('auth-proxy'),
    });
    expect(String(error)).not.toContain(password);
  });

  it('rejects malformed readiness markers instead of accepting substring matches', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-status-malformed-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({ displayCredentials: { username: DISPLAY_USERNAME, password: 'malformed-status-password' } });
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT.replace('Xvfb=running', 'not-Xvfb=running-extra') };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await expect(startDisplayStack({ sandbox: sandbox(), client, store, secrets: [] }))
      .rejects.toMatchObject({ message: expect.stringContaining('Xvfb') });
  });

  it('composes display startup after runtime secret synchronization', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-runtime-'));
    const password = 'runtime-display-password';
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({ displayCredentials: { username: DISPLAY_USERNAME, password } });
    const events: string[] = [];
    const commands: VercelRunCommandRequest[] = [];
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => { events.push('runtime-upload'); }),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        events.push(request.cmd);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const runner: ShellRunner = {
      exec: vi.fn(),
      execQuiet: vi.fn(),
      spawnInherit: vi.fn(),
    };
    const secrets: string[] = [];

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { GH_TOKEN: 'github-runtime-secret', HOME: stateHome },
      shellRunner: runner,
      sandbox: sandbox(),
      client,
      stderr: new PassThrough(),
      piRoot: join(stateHome, 'missing-pi'),
      displayCredentialsStore: store,
      secrets,
    });

    expect(events.indexOf('/usr/local/bin/devbox-start')).toBeGreaterThan(events.indexOf('runtime-upload'));
    expect(commands.find((request) => request.cmd === '/usr/local/bin/devbox-start')?.env?.DEVBOX_NOVNC_PASSWORD)
      .toBe(password);
    expect(secrets).toContain(password);
  });

  it.each(['up', 'attach'] as const)('starts the display stack during provider %s before terminal attach', async (action) => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-display-provider-up-'));
    const branch = 'feature/display';
    const remote = 'github.com/acme/repo';
    const password = 'provider-up-display-password';
    const identity = createVercelIdentity({ remote, branch, scope: { teamId: 'team-1', projectId: 'project-1' } });
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
    const events: string[] = [];
    const commands: VercelRunCommandRequest[] = [];
    const handle = { name: identity.name, cwd: '/vercel/sandbox', status: 'running' } as unknown as VercelSandboxHandle;
    const lifecycle = {
      up: vi.fn(async () => { events.push('lifecycle-up'); return handle; }),
      attach: vi.fn(async () => { events.push('lifecycle-attach'); return handle; }),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => { events.push('runtime-upload'); }),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        events.push(request.cmd);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => STATUS_OUTPUT };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => { events.push('terminal-attach'); return { status: 'detached' as const, reason: 'escape' as const }; }),
    };
    const runner: ShellRunner = {
      exec: vi.fn(async (_command, args) => {
        if (args[0] === 'remote') return 'git@github.com:Acme/Repo.git';
        if (args[0] === 'ls-remote' && args.includes('--symref')) return 'ref: refs/heads/main\tHEAD\n';
        throw new Error(`unexpected exec: ${args.join(' ')}`);
      }),
      execQuiet: vi.fn(async (_command, args) => args[0] === 'check-ref-format'
        ? { stdout: '', code: 0 }
        : { stdout: `sha\trefs/heads/${branch}\n`, code: 0 }),
      spawnInherit: vi.fn(),
    };
    const request: ProviderBranchRequest = {
      repoRoot: '/host/repo',
      repoName: 'repo',
      env: {
        HOME: stateHome,
        GH_TOKEN: 'github-runtime-secret',
        VERCEL_TOKEN: 'vercel-token',
        VERCEL_TEAM_ID: 'team-1',
        VERCEL_PROJECT_ID: 'project-1',
      },
      tty: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      branch,
    };
    const provider = createVercelProvider({
      stateHome,
      runner,
      lifecycle,
      client,
      terminal,
      confirmation: vi.fn(async () => true),
    });

    const result = action === 'up' ? provider.up(request) : provider.attach(request);
    await expect(result).resolves.toEqual({ exitCode: 0 });

    expect(events.indexOf('/usr/local/bin/devbox-start')).toBeGreaterThan(events.indexOf(`lifecycle-${action}`));
    expect(events.indexOf('terminal-attach')).toBeGreaterThan(events.indexOf('/usr/local/bin/devbox-status'));
    expect(commands.find((command) => command.cmd === '/usr/local/bin/devbox-start')?.env?.DEVBOX_NOVNC_PASSWORD)
      .toBe(password);
  });
});
