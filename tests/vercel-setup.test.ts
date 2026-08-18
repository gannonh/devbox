import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  decideSetupLaunch,
  launchBackgroundSetup,
  parseSetupStatus,
  renderSetupNotice,
  renderSetupScript,
  SETUP_DIRECTORY,
  SETUP_LOG_PATH,
  SETUP_SCRIPT_PATH,
  SETUP_STATUS_PATH,
  type VercelSetupStatus,
} from '../src/providers/vercel/setup.js';
import { prepareSandboxRuntime } from '../src/providers/vercel/runtime.js';
import { createVercelBranchMetadataStore, createVercelScopeMetadataStore } from '../src/providers/vercel/metadata.js';
import { createVercelProvider } from '../src/providers/vercel/provider.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import { VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
import type { ProviderBranchRequest } from '../src/providers/types.js';
import type { ShellRunner } from '../src/lib/shell.js';
import type { VercelLifecycle } from '../src/providers/vercel/lifecycle.js';
import type { VercelTerminalAdapter } from '../src/providers/vercel/terminal.js';
import { DISPLAY_USERNAME } from '../src/providers/vercel/display-credentials.js';
import type {
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
  VercelWriteFile,
} from '../src/providers/vercel/client.js';

const execFileAsync = promisify(execFile);

function sandbox(): VercelSandboxHandle {
  return { name: 'setup-test', status: 'running', cwd: '/vercel/sandbox' } as VercelSandboxHandle;
}

describe('Vercel background setup', () => {
  it('uploads the stable script and launches it detached without waiting for completion', async () => {
    const uploads: VercelWriteFile[][] = [];
    const commands: VercelRunCommandRequest[] = [];
    const detached = { exitCode: null, wait: vi.fn() };
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async (_sandbox, files) => { uploads.push(files); }),
      runCommand: vi.fn(async (_sandbox, request) => {
        commands.push(request);
        if (request.cmd === 'cat') {
          return { exitCode: 0, stdout: async () => '{"status":"failed","startedAt":1,"finishedAt":2,"failedStep":"dependencies"}\n' };
        }
        if (request.cmd === 'sh') return { exitCode: 1 };
        if (request.detached) return detached;
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await expect(launchBackgroundSetup({
      sandbox: sandbox(),
      client,
      workspace: '/vercel/sandbox/repo',
    })).resolves.toMatchObject({ status: 'running' });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toEqual([{
      path: SETUP_SCRIPT_PATH,
      content: expect.any(Buffer),
      mode: 0o755,
    }]);
    expect(String(uploads[0][0].content)).toContain("cd '/vercel/sandbox/repo'");
    expect(commands.find((request) => request.detached)).toMatchObject({
      cmd: 'bash',
      args: [SETUP_SCRIPT_PATH],
      cwd: '/vercel/sandbox/repo',
      detached: true,
    });
    expect(detached.wait).not.toHaveBeenCalled();
    expect(SETUP_STATUS_PATH).toBe('/vercel/.devbox/runtime/setup.status');
    expect(SETUP_LOG_PATH).toBe('/vercel/.devbox/runtime/setup.log');
  });

  it('rejects a completed detached launch failure', async () => {
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => request.detached ? { exitCode: 7 } : { exitCode: 1 }),
    } as unknown as VercelSandboxClient;

    await expect(launchBackgroundSetup({
      sandbox: sandbox(),
      client,
      workspace: '/vercel/sandbox/repo',
    })).rejects.toThrow('background setup launch failed with exit code 7');
  });

  it('parses deterministic statuses and renders only safe setup notices', () => {
    expect(parseSetupStatus('{"status":"running","startedAt":100,"finishedAt":null}\n')).toEqual({
      status: 'running',
      startedAt: 100,
      finishedAt: null,
    });
    expect(parseSetupStatus('{"status":"failed","startedAt":100,"finishedAt":101,"failedStep":"post-create"}\n'))
      .toEqual({ status: 'failed', startedAt: 100, finishedAt: 101, failedStep: 'post-create' });
    expect(parseSetupStatus('{"status":"succeeded","startedAt":101,"finishedAt":100}\n')).toBeNull();
    expect(parseSetupStatus('{"status":"succeeded","startedAt":1,"finishedAt":null}\n')).toBeNull();
    expect(parseSetupStatus('{"status":"running","startedAt":1,"finishedAt":2}\n')).toBeNull();
    expect(parseSetupStatus('not status')).toBeNull();

    expect(renderSetupNotice({ status: 'running', startedAt: 1, finishedAt: null })).toBe(
      'setup running; log: /vercel/.devbox/runtime/setup.log',
    );
    expect(renderSetupNotice({ status: 'failed', startedAt: 1, finishedAt: 2, failedStep: 'dependencies' })).toBe([
      'setup failed; log: /vercel/.devbox/runtime/setup.log',
      'setup retry: bash /vercel/.devbox/runtime/setup.sh',
    ].join('\n'));
    expect(renderSetupNotice({ status: 'succeeded', startedAt: 1, finishedAt: 2 })).toBe('');
    expect(renderSetupNotice({ status: 'failed', startedAt: 1, finishedAt: 2, failedStep: 'secret-value' }))
      .not.toContain('secret-value');
  });

  it('renders the local-provider step order, skip checks, and atomic status/log handling', () => {
    const script = renderSetupScript('/vercel/sandbox/repo');

    expect(script.split('\n')[1]).toBe('set -u');
    expect(script).toContain('if [[ -f bun.lock && ! -d node_modules/bun ]]');
    expect(script).toContain('node_modules/.pnpm');
    expect(script).toContain('package-lock.json && ! -f node_modules/.package-lock.json');
    expect(script).toContain('bun install');
    expect(script).toContain('pnpm install --frozen-lockfile');
    expect(script).toContain('npm ci');
    expect(script).toContain('grep -q \'"ensure:electron"\' package.json');
    expect(script).toContain("jq -r '.packages[]?'");
    expect(script).toContain('pi install "${spec}" --approve');
    expect(script).toContain('record_warning pi-extension');
    expect(script).toContain('[[ -x .devbox/post-create.sh ]]');
    expect(script).toContain('record_warning post-create');
    expect(script).toContain('mv -f "${tmp}" "${STATUS}"');
    expect(script).toContain('exec >>"${LOG}" 2>&1');
    expect(script).toContain('exec 200>"${DIRECTORY}/setup.lock"');
    expect(script).toContain('if ! flock -n 200; then exit 0; fi');
    expect(script).not.toContain('${LOCK}/owner');
    expect(script).not.toContain('for attempt in $(seq 1 20); do');
    expect(script).not.toContain('sleep 0.01');
    expect(script).not.toContain('trap ');
    expect(script).toContain('> "${tmp}" || return 1');
    expect(script).toContain('chmod 600 "${tmp}" || return 1');
    expect(script).toContain('mv -f "${tmp}" "${STATUS}" || return 1');
    expect(script).toContain('mv -f "${tmp}" "${path}" || return 1');
    expect(script).toContain('mkdir -p "${DIRECTORY}" || exit 1');
    expect(script).toContain('chmod 700 "${DIRECTORY}" || exit 1');
    expect(script).toContain('touch "${LOG}" || exit 1');
    expect(script).toContain('chmod 600 "${LOG}" || exit 1');
    expect(script).toContain('if ! write_status running "${started}" null; then');
    expect(script).toContain('if ! write_private_value "${PID}" "$$"; then');
    expect(script).toContain('if ! write_status succeeded "${started}" "$(now)"; then');
    expect(script.indexOf('if ! write_status running "${started}" null; then'))
      .toBeLessThan(script.indexOf('if ! write_private_value "${PID}" "$$"; then'));
    const failedStatus = script.indexOf('if ! write_status failed');
    expect(failedStatus).toBeGreaterThan(-1);
    expect(failedStatus).toBeLessThan(script.indexOf('rm -f "${PID}" || true', failedStatus));
    expect(script.indexOf('if ! write_status succeeded "${started}" "$(now)"; then'))
      .toBeLessThan(script.lastIndexOf('rm -f "${PID}" || true'));
    const logRedirection = script.indexOf('exec >>"${LOG}" 2>&1');
    expect(script.indexOf('if ! write_status running "${started}" null; then')).toBeLessThan(logRedirection);
    expect(script.indexOf('if ! write_private_value "${PID}" "$$"; then')).toBeLessThan(logRedirection);

    expect(script.indexOf('bun install')).toBeLessThan(script.indexOf('pnpm install --frozen-lockfile'));
    expect(script.indexOf('pnpm install --frozen-lockfile')).toBeLessThan(script.indexOf('npm ci'));
    expect(script.indexOf('npm ci')).toBeLessThan(script.indexOf('ensure:electron'));
    expect(script.indexOf('ensure:electron')).toBeLessThan(script.indexOf(".packages[]?"));
    expect(script.indexOf(".packages[]?")).toBeLessThan(script.indexOf('.devbox/post-create.sh'));
  });

  it('keeps readiness usable and prints the deterministic failure pointer', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-setup-provider-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-setup-provider-repo-'));
    const envPath = join(repoRoot, '.env');
    await writeFile(envPath, 'SAFE=value\n');
    await createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/setup',
    }).write({ displayCredentials: { username: DISPLAY_USERNAME, password: 'display-secret' } });
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });
    const events: string[] = [];
    const handle = { ...sandbox(), routes: [] } as VercelSandboxHandle;
    const lifecycle = {
      up: vi.fn(async () => handle),
    } as unknown as VercelLifecycle;
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => { events.push('write-files'); }),
      runCommand: vi.fn(async (_sandbox, request) => {
        events.push(request.detached ? 'setup-detached' : request.cmd);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return { exitCode: 0, stdout: async () => [
            '[devbox-status] Xvfb=running',
            '[devbox-status] fluxbox=running',
            '[devbox-status] x11vnc=running',
            '[devbox-status] websockify=running',
            '[devbox-status] auth-proxy=running',
          ].join('\n') };
        }
        if (request.cmd === 'cat') {
          return { exitCode: 0, stdout: async () =>
            '{"status":"failed","startedAt":1,"finishedAt":2,"failedStep":"dependencies"}\n' };
        }
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => { events.push('terminal-attach'); return { status: 'detached' as const, reason: 'escape' as const }; }),
    };
    const shell: ShellRunner = {
      exec: vi.fn(async (_command, args) => args[0] === 'remote'
        ? 'git@github.com:Acme/Repo.git'
        : 'ref: refs/heads/main\tHEAD\n'),
      execQuiet: vi.fn(async (_command, args) => args[0] === 'check-ref-format'
        ? { stdout: '', code: 0 }
        : { stdout: 'sha\trefs/heads/feature/setup\n', code: 0 }),
      spawnInherit: vi.fn(),
    };
    const request: ProviderBranchRequest = {
      repoRoot,
      repoName: 'repo',
      env: {
        HOME: stateHome,
        DEVBOX_ENV: envPath,
        GH_TOKEN: 'github-secret',
        VERCEL_TOKEN: 'vercel-secret',
        VERCEL_TEAM_ID: 'team-1',
        VERCEL_PROJECT_ID: 'project-1',
      },
      tty: true,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
      branch: 'feature/setup',
    };
    const provider = createVercelProvider({
      stateHome,
      runner: shell,
      lifecycle,
      client,
      terminal,
      confirmation: vi.fn(async () => true),
    });

    await expect(provider.up(request)).resolves.toEqual({ exitCode: 0 });

    expect(output).toContain('setup running; log: /vercel/.devbox/runtime/setup.log');
    expect(output).not.toContain('setup retry: bash /vercel/.devbox/runtime/setup.sh');
    expect(output).not.toContain('github-secret');
    expect(output).not.toContain('vercel-secret');
    expect(output).not.toContain('display-secret');
    expect(events.indexOf('setup-detached')).toBeGreaterThan(events.indexOf('/usr/local/bin/devbox-status'));
    expect(events.at(-1)).toBe('terminal-attach');
  });

  it('executes Pi replay and the repo hook with private deterministic files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-setup-script-'));
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const runtime = join(root, 'runtime');
    await mkdir(workspace);
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'flock'), 0o755);
    await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['pkg-one', 'pkg-two'] }));
    await writeFile(join(bin, 'pi'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/pi.log'\n`);
    await chmod(join(bin, 'pi'), 0o755);
    const hook = join(workspace, '.devbox', 'post-create.sh');
    await mkdir(join(workspace, '.devbox'));
    await writeFile(hook, `#!/bin/sh\nprintf 'hook-ran\\n' > '${root}/hook.log'\n`);
    await chmod(hook, 0o755);

    const script = renderSetupScript(workspace).replaceAll(SETUP_DIRECTORY, runtime);
    const scriptPath = join(root, 'setup.sh');
    await writeFile(scriptPath, script, { mode: 0o755 });
    await execFileAsync('bash', [scriptPath], {
      cwd: workspace,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });

    const statusPath = join(runtime, 'setup.status');
    await expect(readFile(statusPath, 'utf8')).resolves.toContain('"status":"succeeded"');
    await expect(readFile(join(root, 'pi.log'), 'utf8')).resolves.toEqual('install pkg-one --approve\ninstall pkg-two --approve\n');
    await expect(readFile(join(root, 'hook.log'), 'utf8')).resolves.toBe('hook-ran\n');
    expect((await stat(runtime)).mode & 0o777).toBe(0o700);
    expect((await stat(statusPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(runtime, 'setup.log'))).mode & 0o777).toBe(0o600);
    expect((await readdir(runtime)).filter((name) => name.startsWith('setup.status.'))).toEqual([]);
  });

  it('marks dependency failure and recovers on a retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-setup-retry-'));
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const runtime = join(root, 'runtime');
    await mkdir(workspace);
    await mkdir(home);
    await mkdir(bin);
    await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'flock'), 0o755);
    await writeFile(join(workspace, 'package-lock.json'), '{}');
    await mkdir(runtime);
    await writeFile(join(runtime, 'setup.status'), '{"status":"succeeded","startedAt":1,"finishedAt":null}\n');
    const scriptPath = join(root, 'setup.sh');
    await writeFile(scriptPath, renderSetupScript(workspace).replaceAll(SETUP_DIRECTORY, runtime), { mode: 0o755 });
    const npm = join(bin, 'npm');
    await writeFile(npm, '#!/bin/sh\nprintf "npm failed\\n"\nexit 7\n');
    await chmod(npm, 0o755);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` };

    await expect(execFileAsync('bash', [scriptPath], { cwd: workspace, env })).rejects.toMatchObject({ code: 1 });
    const failed = parseSetupStatus(await readFile(join(runtime, 'setup.status'), 'utf8'));
    expect(failed).toMatchObject({ status: 'failed', failedStep: 'dependencies' });
    expect(await readdir(runtime)).not.toContain('setup.pid');

    await writeFile(npm, '#!/bin/sh\nprintf "npm succeeded\\n"\n');
    await chmod(npm, 0o755);
    await expect(execFileAsync('bash', [scriptPath], { cwd: workspace, env })).resolves.toBeDefined();
    expect(parseSetupStatus(await readFile(join(runtime, 'setup.status'), 'utf8'))).toMatchObject({ status: 'succeeded' });
  });

  it('renders attach failure notices and stops repeating them after success', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-setup-attach-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-setup-attach-repo-'));
    const envPath = join(repoRoot, '.env');
    await writeFile(envPath, 'SAFE=value\n');
    const remote = 'github.com/acme/repo';
    const branch = 'feature/setup';
    const identity = createVercelIdentity({ remote, branch, scope: { teamId: 'team-1', projectId: 'project-1' } });
    await createVercelScopeMetadataStore({ stateHome, repoKey: remote }).write({ teamId: 'team-1', projectId: 'project-1' });
    await createVercelBranchMetadataStore({ stateHome, repoKey: remote, branch }).write({
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      displayCredentials: { username: DISPLAY_USERNAME, password: 'display-secret' },
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: branch,
        needsBranchSetup: false,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
    let setupState: VercelSetupStatus = {
      status: 'failed',
      startedAt: 1,
      finishedAt: 2,
      failedStep: 'dependencies',
    };
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => {}),
      runCommand: vi.fn(async (_sandbox, request) => {
        if (request.cmd === '/usr/local/bin/devbox-status') return { exitCode: 0, stdout: async () => [
          '[devbox-status] Xvfb=running',
          '[devbox-status] fluxbox=running',
          '[devbox-status] x11vnc=running',
          '[devbox-status] websockify=running',
          '[devbox-status] auth-proxy=running',
        ].join('\n') };
        if (request.cmd === 'cat') return { exitCode: 0, stdout: async () => `${JSON.stringify(setupState)}\n` };
        if (request.cmd === 'sh' && request.args?.[1]?.includes('kill -0')) return { exitCode: 1 };
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;
    const lifecycle = {
      attach: vi.fn(async () => sandbox()),
    } as unknown as VercelLifecycle;
    const terminal: VercelTerminalAdapter = {
      attach: vi.fn(async () => ({ status: 'detached' as const, reason: 'escape' as const })),
    };
    const provider = createVercelProvider({
      stateHome,
      runner: {
        exec: vi.fn(async () => 'git@github.com:Acme/Repo.git'),
        execQuiet: vi.fn(),
        spawnInherit: vi.fn(),
      },
      lifecycle,
      client,
      terminal,
    });
    const makeRequest = () => {
      const stderr = new PassThrough();
      let output = '';
      stderr.on('data', (chunk) => { output += chunk.toString(); });
      return {
        output: () => output,
        request: {
          repoRoot,
          repoName: 'repo',
          env: { HOME: stateHome, DEVBOX_ENV: envPath, VERCEL_TOKEN: 'vercel-secret' },
          tty: false,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr,
          branch,
        } satisfies ProviderBranchRequest,
      };
    };

    const first = makeRequest();
    await expect(provider.attach(first.request)).resolves.toEqual({ exitCode: 0 });
    expect(first.output()).toContain('setup running; log: /vercel/.devbox/runtime/setup.log');
    expect(first.output()).not.toContain('setup retry: bash /vercel/.devbox/runtime/setup.sh');

    setupState = { status: 'succeeded', startedAt: 1, finishedAt: 3 };
    const second = makeRequest();
    await expect(provider.attach(second.request)).resolves.toEqual({ exitCode: 0 });
    expect(second.output()).not.toContain('setup failed');
    expect(second.output()).not.toContain('setup retry');
  });

  it('starts setup after display readiness and before terminal use', async () => {
    const host = await mkdtemp(join(tmpdir(), 'devbox-setup-runtime-'));
    const envPath = join(host, '.env');
    await writeFile(envPath, 'SAFE=value\n');
    const store = createVercelBranchMetadataStore({
      stateHome: host,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/setup',
    });
    await store.write({ displayCredentials: { username: DISPLAY_USERNAME, password: 'display-secret' } });
    const events: string[] = [];
    const client: VercelSandboxClient = {
      writeFiles: vi.fn(async () => { events.push('write-files'); }),
      runCommand: vi.fn(async (_sandbox, request) => {
        events.push(request.detached ? 'setup-detached' : request.cmd);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          return {
            exitCode: 0,
            stdout: async () => [
              '[devbox-status] Xvfb=running',
              '[devbox-status] fluxbox=running',
              '[devbox-status] x11vnc=running',
              '[devbox-status] websockify=running',
              '[devbox-status] auth-proxy=running',
            ].join('\n'),
          };
        }
        if (request.cmd === 'cat') return { exitCode: 1 };
        return { exitCode: 0 };
      }),
    } as unknown as VercelSandboxClient;

    await prepareSandboxRuntime({
      repoRoot: '/host/repo',
      repository: 'repo',
      env: { HOME: host, DEVBOX_ENV: envPath, GH_TOKEN: 'github-secret' },
      shellRunner: { exec: vi.fn(), execQuiet: vi.fn(), spawnInherit: vi.fn() },
      sandbox: sandbox(),
      client,
      stderr: new PassThrough(),
      piRoot: join(host, 'missing-pi'),
      displayCredentialsStore: store,
    });

    expect(events.indexOf('/usr/local/bin/devbox-status')).toBeGreaterThan(-1);
    expect(events.indexOf('setup-detached')).toBeGreaterThan(events.indexOf('/usr/local/bin/devbox-status'));
  });

  it.each([
    ['absent', null, false, 1, 1],
    ['running-live', { status: 'running', startedAt: 1, finishedAt: null }, true, 0, 0],
    ['running-stale', { status: 'running', startedAt: 1, finishedAt: null }, false, 1, 1],
    ['failed', { status: 'failed', startedAt: 1, finishedAt: 2, failedStep: 'dependencies' }, false, 1, 1],
    ['succeeded', { status: 'succeeded', startedAt: 1, finishedAt: 2 }, false, 0, 0],
  ] as const)('runs the %s public launch decision', async (_name, initialStatus, live, expectedWrites, expectedLaunches) => {
    let status = initialStatus;
    const writeFiles = vi.fn(async () => {});
    const runCommand = vi.fn(async (_sandbox: VercelSandboxHandle, request: VercelRunCommandRequest) => {
      if (request.cmd === 'cat') {
        if (!status) {
          status = { status: 'running', startedAt: 1, finishedAt: null };
          return { exitCode: 1 };
        }
        return { exitCode: 0, stdout: async () => `${JSON.stringify(status)}\n` };
      }
      if (request.cmd === 'sh') return { exitCode: live ? 0 : 1 };
      return { exitCode: 0 };
    });
    const client: VercelSandboxClient = { writeFiles, runCommand } as unknown as VercelSandboxClient;

    await launchBackgroundSetup({ sandbox: sandbox(), client, workspace: '/vercel/sandbox/repo' });

    expect(writeFiles).toHaveBeenCalledTimes(expectedWrites);
    expect(runCommand.mock.calls.filter(([, request]) => request.detached)).toHaveLength(expectedLaunches);
  });

  it.each([
    ['absent', null, false, 'start'],
    ['running-live', { status: 'running', startedAt: 1, finishedAt: null }, true, 'skip-running'],
    ['running-stale', { status: 'running', startedAt: 1, finishedAt: null }, false, 'start'],
    ['failed', { status: 'failed', startedAt: 1, finishedAt: 2, failedStep: 'dependencies' }, false, 'start'],
    ['succeeded', { status: 'succeeded', startedAt: 1, finishedAt: 2 }, false, 'skip-succeeded'],
  ] as const)('applies the %s launch decision', (_name, status, processLive, decision) => {
    expect(decideSetupLaunch(status, processLive)).toBe(decision);
  });
});
