import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  VercelCommandResult,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSandboxHandle,
  VercelWriteFile,
} from '../src/providers/vercel/client.js';
import type { ShellRunner } from '../src/lib/shell.js';
import {
  evaluatePreparation,
  prepareSandboxRuntime,
  VERCEL_RUNTIME_PREPARATION_PATH,
} from '../src/providers/vercel/runtime.js';
import { createVercelBranchMetadataStore } from '../src/providers/vercel/metadata.js';
import { DISPLAY_STATUS_OUTPUT } from './vercel-display-status.fixture.js';

const HEAD = 'b'.repeat(40);

function sandbox(): VercelSandboxHandle {
  return {
    name: 'runtime-sync',
    status: 'running',
    cwd: '/vercel/sandbox',
  } as unknown as VercelSandboxHandle;
}

function runner(): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
  };
}

interface ReattachHarness {
  client: VercelSandboxClient;
  uploads: VercelWriteFile[][];
  commands: VercelRunCommandRequest[];
  files: Map<string, Buffer>;
}

function reattachClient(statusSequence: readonly string[] = [DISPLAY_STATUS_OUTPUT]): ReattachHarness {
  const uploads: VercelWriteFile[][] = [];
  const commands: VercelRunCommandRequest[] = [];
  const files = new Map<string, Buffer>();
  let statusCalls = 0;
  return {
    uploads,
    commands,
    files,
    client: {
      writeFiles: async (_sandbox: VercelSandboxHandle, written: VercelWriteFile[]) => {
        for (const file of written) files.set(file.path, Buffer.from(file.content));
        uploads.push(written);
      },
      runCommand: async (
        _sandbox: VercelSandboxHandle,
        request: VercelRunCommandRequest,
      ): Promise<VercelCommandResult> => {
        commands.push(request);
        if (request.cmd === '/usr/local/bin/devbox-status') {
          const output = statusSequence[Math.min(statusCalls, statusSequence.length - 1)];
          statusCalls += 1;
          return { exitCode: 0, stdout: async () => output };
        }
        const script = request.cmd === 'sh' ? request.args?.[1] ?? '' : '';
        if (script.includes(`cat ${VERCEL_RUNTIME_PREPARATION_PATH}`)) {
          const marker = files.get(VERCEL_RUNTIME_PREPARATION_PATH);
          return {
            exitCode: 0,
            stdout: async () => `${marker?.toString('utf8') ?? ''}\n--DEVBOX--\n${HEAD}\n`,
          };
        }
        if ((request.cmd === 'git' && request.args?.includes('rev-parse'))
          || script.includes('rev-parse HEAD')) {
          return { exitCode: 0, stdout: async () => `${HEAD}\n` };
        }
        return { exitCode: 0 };
      },
    } as unknown as VercelSandboxClient,
  };
}

const BASE_OPTIONS = {
  repoRoot: '/host/repo',
  repository: 'repo',
  env: { GH_TOKEN: 'github-secret' },
  runtimeEnvironment: { API_KEY: 'dotenv-secret' },
} as const;

function prepareOptions(
  overrides: Partial<Parameters<typeof prepareSandboxRuntime>[0]> = {},
): Parameters<typeof prepareSandboxRuntime>[0] {
  return {
    ...BASE_OPTIONS,
    shellRunner: runner(),
    sandbox: sandbox(),
    stderr: new PassThrough(),
    piRoot: '/host/home/missing-pi',
    ...overrides,
  };
}

function markerOf(harness: ReattachHarness): Record<string, unknown> | undefined {
  const upload = harness.uploads.flat().find((file) => file.path === VERCEL_RUNTIME_PREPARATION_PATH);
  return upload === undefined ? undefined : JSON.parse(upload.content.toString('utf8'));
}

describe('preparation evidence', () => {
  const actual = {
    sandboxId: 'sbx-1',
    revision: HEAD,
    githubTokenHash: 'tok-hash',
    environmentHash: 'env-hash',
  };

  it('accepts only an exact four-field match', () => {
    expect(evaluatePreparation({ ...actual }, actual)).toBe(true);
  });

  it('rejects each stale field', () => {
    expect(evaluatePreparation({ ...actual, sandboxId: 'sbx-2' }, actual)).toBe(false);
    expect(evaluatePreparation({ ...actual, revision: 'c'.repeat(40) }, actual)).toBe(false);
    expect(evaluatePreparation({ ...actual, githubTokenHash: 'rotated' }, actual)).toBe(false);
    expect(evaluatePreparation({ ...actual, environmentHash: 'changed' }, actual)).toBe(false);
  });

  it('rejects malformed evidence', () => {
    expect(evaluatePreparation(null, actual)).toBe(false);
    expect(evaluatePreparation('marker', actual)).toBe(false);
    expect(evaluatePreparation([], actual)).toBe(false);
    expect(evaluatePreparation({ sandboxId: 'sbx-1' }, actual)).toBe(false);
    expect(evaluatePreparation({ ...actual, revision: 7 }, actual)).toBe(false);
  });
});

describe('Vercel cheap re-attach', () => {
  it('records evidence after full preparation and skips provisioning on the next attach', async () => {
    const harness = reattachClient();

    const boot = await prepareSandboxRuntime(prepareOptions({ client: harness.client }));
    expect(boot.reused).toBe(false);
    const marker = markerOf(harness);
    expect(marker).toEqual({
      sandboxId: 'runtime-sync',
      revision: HEAD,
      githubTokenHash: createHash('sha256').update('github-secret', 'utf8').digest('hex'),
      environmentHash: createHash('sha256').update('API_KEY=dotenv-secret', 'utf8').digest('hex'),
    });

    const commandCount = harness.commands.length;
    const uploadCount = harness.uploads.length;
    const reused = await prepareSandboxRuntime(prepareOptions({
      client: harness.client,
      mode: 'attach',
    }));

    expect(reused).toEqual({ setupStatus: null, reused: true });
    expect(harness.commands.slice(commandCount).map((command) => command.cmd))
      .toEqual(['sh']);
    expect(harness.uploads.slice(uploadCount)).toEqual([]);
    expect(harness.commands.slice(commandCount).some((command) =>
      (command.args?.[1] ?? '').includes('gh auth login'))).toBe(false);
  });

  it('takes the full path when no evidence exists', async () => {
    const harness = reattachClient();
    const result = await prepareSandboxRuntime(prepareOptions({
      client: harness.client,
      mode: 'attach',
    }));

    expect(result.reused).toBe(false);
    expect(harness.commands.some((command) =>
      (command.args?.[1] ?? '').includes('gh auth login'))).toBe(true);
    expect(harness.uploads.flat().map((file) => file.path))
      .toContain('/vercel/.devbox/runtime/github-token');
  });

  it('takes the full path when the box is not the prepared instance or HEAD moved', async () => {
    for (const mutated of [
      { sandboxId: 'another-box' },
      { revision: 'c'.repeat(40) },
    ]) {
      const harness = reattachClient();
      await prepareSandboxRuntime(prepareOptions({ client: harness.client }));
      const files = new Map(harness.files);
      const marker = JSON.parse(files.get(VERCEL_RUNTIME_PREPARATION_PATH)!.toString('utf8'));
      harness.files.set(
        VERCEL_RUNTIME_PREPARATION_PATH,
        Buffer.from(JSON.stringify({ ...marker, ...mutated })),
      );

      const result = await prepareSandboxRuntime(prepareOptions({
        client: harness.client,
        mode: 'attach',
      }));
      expect(result.reused).toBe(false);
      expect(harness.commands.some((command) =>
        (command.args?.[1] ?? '').includes('gh auth login'))).toBe(true);
    }
  });

  it('takes the full path when the host token or dotenv rotated', async () => {
    const tokenHarness = reattachClient();
    await prepareSandboxRuntime(prepareOptions({ client: tokenHarness.client }));
    const before = tokenHarness.commands.length;
    await prepareSandboxRuntime(prepareOptions({
      client: tokenHarness.client,
      env: { GH_TOKEN: 'rotated-secret' },
      mode: 'attach',
    }));
    expect(tokenHarness.commands.slice(before).some((command) =>
      (command.args?.[1] ?? '').includes('gh auth login'))).toBe(true);

    const hostEnv = await mkdtemp(join(tmpdir(), 'devbox-reattach-env-'));
    const envPath = join(hostEnv, '.env');
    await writeFile(envPath, 'API_KEY=dotenv-secret\n');
    const envHarness = reattachClient();
    await prepareSandboxRuntime(prepareOptions({
      client: envHarness.client,
      runtimeEnvironment: undefined,
      envPath,
    }));
    await writeFile(envPath, 'API_KEY=rotated-secret\n');
    const envRotated = await prepareSandboxRuntime(prepareOptions({
      client: envHarness.client,
      runtimeEnvironment: undefined,
      envPath,
      mode: 'attach',
    }));
    expect(envRotated.reused).toBe(false);
    expect(envHarness.uploads.flat().filter((file) => file.path === '/vercel/.devbox/runtime/environment.json').length)
      .toBe(2);
  });

  it('falls back to full display startup when services are down on a cheap attach', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-reattach-display-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/display',
    });
    await store.write({ displayCredentials: { username: 'devbox', password: 'display-password' } });
    const harness = reattachClient([DISPLAY_STATUS_OUTPUT, DISPLAY_STATUS_OUTPUT.replace('Xvfb=running', 'Xvfb=stopped'), DISPLAY_STATUS_OUTPUT]);

    await prepareSandboxRuntime(prepareOptions({
      client: harness.client,
      displayCredentialsStore: store,
    }));
    const uploadCount = harness.uploads.length;
    const reused = await prepareSandboxRuntime(prepareOptions({
      client: harness.client,
      mode: 'attach',
      displayCredentialsStore: store,
    }));

    expect(reused).toEqual({ setupStatus: null, reused: true });
    const reuploaded = harness.uploads.slice(uploadCount).flat().map((file) => file.path);
    expect(reuploaded).toContain('/vercel/.devbox/runtime/novnc-proxy.mjs');
    expect(reuploaded.some((path) =>
      path === '/vercel/.devbox/runtime/github-token'
      || path === '/vercel/.devbox/runtime/environment.json'
      || path.startsWith('/vercel/.pi/'))).toBe(false);
    expect(harness.commands.some((command) => command.cmd === '/usr/local/bin/devbox-start')).toBe(true);
  });
});
