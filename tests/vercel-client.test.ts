import { describe, expect, it, vi } from 'vitest';
import { Sandbox as MockSandbox, Snapshot as MockSnapshot } from '@vercel/sandbox-mock';
import {
  buildVercelSandboxCreateRequest,
  createVercelSandboxClient,
  isVercelNotFound,
  isVercelStale,
  VercelSdkError,
} from '../src/providers/vercel/client.js';
import { TEST_IMAGE_REFERENCE } from './vercel-image.fixture.js';

describe('Vercel Sandbox client adapter', () => {
  it('deletes a stale named sandbox through the authenticated v2 fetch seam', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createVercelSandboxClient({ fetch });

    await expect(client.deleteSandboxByName({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'stale sandbox',
    })).resolves.toEqual({ missing: false });

    expect(fetch).toHaveBeenCalledWith(
      'https://vercel.com/api/v2/sandboxes/stale%20sandbox?teamId=team&projectId=project',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ Authorization: 'Bearer vercel-token' }),
      }),
    );
  });

  it('treats a stale-name delete 404 as already missing without surfacing an error', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const client = createVercelSandboxClient({ fetch });

    await expect(client.deleteSandboxByName({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'already-missing',
    })).resolves.toEqual({ missing: true });
    expect(isVercelNotFound(new VercelSdkError('delete', Object.assign(new Error('missing'), { status: 404 }), ['vercel-token']))).toBe(true);
    expect(isVercelNotFound(new VercelSdkError('delete', Object.assign(new Error('stale'), { status: 410 }), ['vercel-token']))).toBe(false);
    expect(isVercelStale(new VercelSdkError('delete', Object.assign(new Error('stale'), { status: 410 }), ['vercel-token']))).toBe(true);
  });

  it('redacts raw and URL-encoded tokens from stale-name delete errors', async () => {
    const token = 'vercel:token/secret';
    const fetch = vi.fn(async () => new Response(
      `request failed ${encodeURIComponent(token)}`,
      { status: 500 },
    ));
    const client = createVercelSandboxClient({ fetch });

    await expect(client.deleteSandboxByName({
      credentials: { token, teamId: 'team', projectId: 'project' },
      name: 'stale-error',
    })).rejects.toThrow('[REDACTED]');
  });

  it('sends a v3 create request through the real SDK fetch seam', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { url: String(input), init: init ?? {} };
      requests.push(request);
      if (request.init.method !== 'POST') {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const now = Date.now();
      const session = {
        id: 'session-fetch',
        memory: 2048,
        vcpus: 1,
        region: 'iad1',
        timeout: 1_800_000,
        status: 'running',
        requestedAt: now,
        createdAt: now,
        cwd: '/vercel/sandbox',
        updatedAt: now,
      };
      return new Response(JSON.stringify({
        sandbox: {
          name: 'fetch-create',
          persistent: true,
          image: TEST_IMAGE_REFERENCE,
          timeout: 1_800_000,
          createdAt: now,
          updatedAt: now,
          currentSessionId: session.id,
          status: session.status,
          tags: {
            provider: 'vercel',
            repository: 'github-com-acme-repo',
            branch: 'main',
            version: 'v-1',
            identity: 'identity',
          },
          keepLastSnapshots: { count: 1 },
        },
        session,
        routes: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createVercelSandboxClient({ fetch });

    const handle = await client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'fetch-create',
      image: TEST_IMAGE_REFERENCE,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeout: 1_800_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: {
        provider: 'vercel',
        repository: 'github-com-acme-repo',
        branch: 'main',
        version: 'v-1',
        identity: 'identity',
      },
    });

    expect(handle.name).toBe('fetch-create');
    const lookupRequest = requests.find(({ init }) => init.method !== 'POST');
    expect(lookupRequest?.url).toBe('https://vercel.com/api/v2/sandboxes/fetch-create?teamId=team&projectId=project');
    expect(lookupRequest?.init.headers).toMatchObject({ Authorization: 'Bearer vercel-token' });
    const createRequest = requests.find(({ init }) => init.method === 'POST');
    expect(createRequest).toBeDefined();
    expect(createRequest?.url).toBe('https://vercel.com/api/v3/sandboxes?teamId=team');
    expect(createRequest?.init.headers).toMatchObject({
      Authorization: 'Bearer vercel-token',
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(createRequest?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      projectId: 'project',
      image: TEST_IMAGE_REFERENCE,
      name: 'fetch-create',
      persistent: true,
      keepLastSnapshots: { count: 1 },
      timeout: 1_800_000,
      tags: {
        provider: 'vercel',
        repository: 'github-com-acme-repo',
        branch: 'main',
        version: 'v-1',
        identity: 'identity',
      },
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        username: 'x-access-token',
        password: 'github-token',
        revision: 'main',
      },
    });
    expect(body.ports).toEqual([]);
    expect('runtime' in body).toBe(false);
    expect(JSON.stringify({ url: createRequest?.url, body })).not.toContain('vercel-token');
  });

  it('forwards writeFiles and object-form runCommand env through the redacted sandbox handle', async () => {
    const writeFiles = vi.fn(async () => {});
    const runCommand = vi.fn(async () => ({ exitCode: 0 }));
    const target = {
      name: 'runtime-capabilities',
      status: 'running' as const,
      writeFiles,
      runCommand,
    };
    const client = createVercelSandboxClient({
      sandbox: {
        getOrCreate: vi.fn(async () => target),
        get: vi.fn(),
        list: vi.fn(),
      } as never,
    });
    const handle = await client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'runtime-capabilities',
      image: TEST_IMAGE_REFERENCE,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeout: 10_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: {},
    });
    const files = [{ path: '/vercel/.env', content: Buffer.from('safe'), mode: 0o600 }];
    const request = {
      cmd: 'gh',
      args: ['auth', 'status'],
      env: { GH_CONFIG_DIR: '/vercel/.devbox/runtime/gh' },
    };

    await client.writeFiles(handle, files);
    await client.runCommand(handle, request);

    expect(writeFiles).toHaveBeenCalledWith(files, undefined);
    expect(runCommand).toHaveBeenCalledWith(request);
  });

  it('redacts secrets from added writeFiles failures', async () => {
    const secret = 'github-write-secret';
    const target = {
      name: 'runtime-write-error',
      status: 'running' as const,
      writeFiles: vi.fn(async () => { throw new Error(`write failed ${secret}`); }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
    };
    const client = createVercelSandboxClient({
      sandbox: {
        getOrCreate: vi.fn(async () => target),
        get: vi.fn(),
        list: vi.fn(),
      } as never,
    });
    const handle = await client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'runtime-write-error',
      image: TEST_IMAGE_REFERENCE,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: secret,
      },
      timeout: 10_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: {},
    });

    await expect(client.writeFiles(handle, [{ path: '/vercel/.env', content: Buffer.from('safe') }]))
      .rejects.toEqual(expect.objectContaining({
        message: expect.stringContaining('[REDACTED]'),
      }));
    await expect(client.writeFiles(handle, [{ path: '/vercel/.env', content: Buffer.from('safe') }]))
      .rejects.toEqual(expect.objectContaining({
        message: expect.not.stringContaining(secret),
      }));
  });

  it('passes an explicit cwd through the SDK object runCommand overload', async () => {
    const runCommand = vi.fn(async (params: { cmd: string; args?: string[]; cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => {
      expect(params).toEqual({
        cmd: 'git',
        args: ['status', '--porcelain'],
        cwd: '/vercel/sandbox/repo',
        signal: expect.any(AbortSignal),
        timeoutMs: 12_345,
      });
      return { exitCode: 0 };
    });
    const sandbox = {
      name: 'object-command',
      status: 'running' as const,
      runCommand,
    } as never;
    const client = createVercelSandboxClient();
    const controller = new AbortController();

    await expect(client.runCommand(sandbox, {
      cmd: 'git',
      args: ['status', '--porcelain'],
      cwd: '/vercel/sandbox/repo',
      signal: controller.signal,
      timeoutMs: 12_345,
    })).resolves.toEqual({ exitCode: 0 });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]).toEqual([{
      cmd: 'git',
      args: ['status', '--porcelain'],
      cwd: '/vercel/sandbox/repo',
      signal: controller.signal,
      timeoutMs: 12_345,
    }]);
  });

  it('passes resume=false in a real SDK GET request (mock omits the query)', async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      const now = Date.now();
      const session = {
        id: 'session-stopped',
        memory: 2048,
        vcpus: 1,
        region: 'iad1',
        timeout: 1_800_000,
        status: 'stopped',
        requestedAt: now,
        createdAt: now,
        cwd: '/vercel/sandbox',
        updatedAt: now,
      };
      return new Response(JSON.stringify({
        sandbox: {
          name: 'resume-false',
          persistent: true,
          image: TEST_IMAGE_REFERENCE,
          timeout: 1_800_000,
          createdAt: now,
          updatedAt: now,
          currentSessionId: session.id,
          status: session.status,
          tags: { provider: 'vercel', repository: 'repo', branch: 'main', version: 'v', identity: 'id' },
          keepLastSnapshots: { count: 1 },
        },
        session,
        routes: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = createVercelSandboxClient({ fetch });

    const handle = await client.get({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'resume-false',
      resume: false,
    });

    expect(requests).toEqual([
      'https://vercel.com/api/v2/sandboxes/resume-false?teamId=team&projectId=project&resume=false',
    ]);
    expect(handle.status).toBe('stopped');
  });

  it('uses the real SDK classes through the sandbox-mock lifecycle boundary (mock omits resume query)', async () => {
    const client = createVercelSandboxClient({
      sandbox: MockSandbox as never,
      snapshot: MockSnapshot as never,
    });
    const handle = await client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'mock-client-adapter',
      image: TEST_IMAGE_REFERENCE,
      ports: [3000],
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeout: 10_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: {
        provider: 'vercel',
        repository: 'repo',
        branch: 'main',
        version: 'v',
        identity: 'id',
      },
    });
    const mockHandle = handle as unknown as {
      writeFiles(files: { path: string; content: string }[]): Promise<void>;
      fs: { readFile(path: string, encoding: 'utf8'): Promise<string> };
    };
    await mockHandle.writeFiles([{ path: '/tmp/client.txt', content: 'adapter' }]);
    await expect(mockHandle.fs.readFile('/tmp/client.txt', 'utf8')).resolves.toBe('adapter');
    expect(handle.routes).toEqual(expect.arrayContaining([expect.objectContaining({ port: 3000 })]));
    expect(handle.domain(3000)).toMatch(/^https?:\/\//);
    const command = await handle.runCommand({ cmd: 'pwd', cwd: '/tmp' });
    await expect(command.stdout?.()).resolves.toContain('/tmp');
    await expect(client.listSandboxes({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      tags: { provider: 'vercel', repository: 'repo' },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mock-client-adapter' }),
    ]));
    await expect(client.listSessions(handle)).resolves.toEqual([
      expect.objectContaining({ status: 'running' }),
    ]);
    await client.stopSandbox(handle);
    await expect(client.listSessions(handle)).resolves.toEqual([
      expect.objectContaining({ status: 'stopped' }),
    ]);
    // sandbox-mock omits the resume=false query; the real SDK fetch seam above covers it.
    const attached = await client.get({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'mock-client-adapter',
      resume: false,
    });
    expect(attached.name).toBe('mock-client-adapter');
    expect(attached.status).toBe('stopped');
    await expect(client.listSnapshots({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'mock-client-adapter',
    })).resolves.toEqual([]);
    await client.deleteSandbox(attached);
  });

  it('covers snapshot create, list, get, and delete through sandbox-mock', async () => {
    const sandbox = await MockSandbox.create({
      name: 'mock-snapshot-lifecycle',
      image: TEST_IMAGE_REFERENCE,
      timeout: 10_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: {
        provider: 'vercel',
        repository: 'repo',
        branch: 'main',
        version: 'v',
        identity: 'snapshot',
      },
    });
    const command = await sandbox.runCommand('echo', ['snapshot']);
    expect(command.exitCode).toBe(0);
    const created = await sandbox.snapshot();
    expect(created.snapshotId).toBeTruthy();

    const listed = await MockSnapshot.list({ name: sandbox.name }).then((page) => page.toArray());
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.snapshotId, status: 'created' }),
    ]));
    const fetched = await MockSnapshot.get({ snapshotId: created.snapshotId });
    expect(fetched.snapshotId).toBe(created.snapshotId);
    expect(fetched.status).toBe('created');

    await fetched.delete();
    const afterDelete = await MockSnapshot.list({ name: sandbox.name }).then((page) => page.toArray());
    expect(afterDelete).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.snapshotId, status: 'deleted' }),
    ]));
    await sandbox.delete();
  });

  it('uses a short untagged server prefix and filters sandbox names and tags locally', async () => {
    const requestedPrefix = 's'.repeat(63);
    const expectedTags = {
      provider: 'vercel',
      repository: 'repo-tag',
      branch: 'main-tag',
      version: 'version-tag',
      identity: 'identity-tag',
    };
    const requests: Record<string, unknown>[] = [];
    const client = createVercelSandboxClient({
      sandbox: {
        getOrCreate: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async (request) => {
          requests.push(request);
          return {
            pages: async function* () {
              yield { sandboxes: [
                {
                  name: `${requestedPrefix}-wrong-tags`,
                  persistent: true,
                  status: 'stopped' as const,
                  tags: { ...expectedTags, identity: 'other' },
                },
              ] };
              yield { sandboxes: [
                {
                  name: requestedPrefix,
                  persistent: true,
                  status: 'stopped' as const,
                  tags: expectedTags,
                },
                {
                  name: 's'.repeat(32) + '-different-name',
                  persistent: true,
                  status: 'stopped' as const,
                  tags: expectedTags,
                },
              ] };
            },
          };
        }),
      } as never,
    });

    await expect(client.listSandboxes({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      namePrefix: requestedPrefix,
      tags: expectedTags,
    })).resolves.toEqual([expect.objectContaining({ name: requestedPrefix })]);

    expect(requests).toHaveLength(1);
    expect(requests[0].namePrefix).toBe(requestedPrefix.slice(0, 32));
    expect(requests[0]).not.toHaveProperty('tags');
  });

  it('redacts and stabilizes sandbox-list 400 diagnostics', async () => {
    const token = 'vercel-list-secret';
    const client = createVercelSandboxClient({
      sandbox: {
        getOrCreate: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => { throw new Error(`Status code 400 for ${token} team project`); }),
      } as never,
    });

    const caught = await client.listSandboxes({
      credentials: { token, teamId: 'team', projectId: 'project' },
      namePrefix: 'devbox-smoke-',
    }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(VercelSdkError);
    expect((caught as Error).message).toBe('Status code 400 for [REDACTED] [REDACTED] [REDACTED]');
    expect((caught as Error).message).not.toContain(token);
  });

  it('consumes every SDK sandbox and snapshot pagination page', async () => {
    const sessionHandle = {
      name: 'session-pages',
      status: 'running' as const,
      listSessions: vi.fn(async () => ({
        pages: async function* () {
          yield { sessions: [{ id: 'session-one', status: 'stopped' as const }] };
          yield { sessions: [{ id: 'session-two', status: 'aborted' as const }] };
        },
      })),
      stop: vi.fn(),
      delete: vi.fn(),
      runCommand: vi.fn(),
      domain: vi.fn(),
    };
    const client = createVercelSandboxClient({
      sandbox: {
        getOrCreate: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => ({
          pages: async function* () {
            yield { sandboxes: [{ name: 'one', persistent: true, status: 'stopped' as const }] };
            yield { sandboxes: [{ name: 'two', persistent: true, status: 'aborted' as const }] };
          },
        })),
      } as never,
      snapshot: {
        list: vi.fn(async () => ({
          pages: async function* () {
            yield { snapshots: [{ id: 'snap-one', sourceSessionId: 'session', status: 'created' as const }] };
            yield { snapshots: [{ id: 'snap-two', sourceSessionId: 'session', status: 'deleted' as const }] };
          },
        })),
        get: vi.fn(),
      } as never,
    });
    const scope = { token: 'vercel-token', teamId: 'team', projectId: 'project' };

    await expect(client.listSandboxes({ credentials: scope })).resolves.toEqual([
      expect.objectContaining({ name: 'one' }),
      expect.objectContaining({ name: 'two' }),
    ]);
    await expect(client.listSessions(sessionHandle)).resolves.toEqual([
      expect.objectContaining({ id: 'session-one' }),
      expect.objectContaining({ id: 'session-two' }),
    ]);
    await expect(client.listSnapshots({ credentials: scope, name: 'sandbox' })).resolves.toEqual([
      expect.objectContaining({ id: 'snap-one' }),
      expect.objectContaining({ id: 'snap-two' }),
    ]);
  });

  it('serializes credentials only into SDK fields and never adds a runtime option', async () => {
    const captured: Record<string, unknown>[] = [];
    const handle = {
      name: 'serialized',
      status: 'running' as const,
      listSessions: async () => [],
      stop: async () => ({ id: 'session', status: 'stopped' as const }),
      delete: async () => {},
      runCommand: async () => ({ exitCode: 0 }),
      domain: () => 'https://sandbox.example',
    };
    const client = createVercelSandboxClient({
      sandbox: {
        getOrCreate: vi.fn(async (params) => {
          captured.push(params);
          return handle;
        }),
        get: vi.fn(),
        list: vi.fn(),
      } as never,
    });

    await client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'serialized',
      image: TEST_IMAGE_REFERENCE,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'feature',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeout: 1_800_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: { provider: 'vercel', repository: 'repo', branch: 'feature', version: 'v', identity: 'id' },
    });

    expect(captured[0]).toMatchObject({
      token: 'vercel-token',
      teamId: 'team',
      projectId: 'project',
      image: TEST_IMAGE_REFERENCE,
      source: { username: 'x-access-token', password: 'github-token', revision: 'feature' },
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: { provider: 'vercel', repository: 'repo' },
    });
    expect('runtime' in captured[0]).toBe(false);
  });

  it('redacts both Vercel and GitHub tokens from SDK errors', async () => {
    const client = createVercelSandboxClient({
      sandbox: {
        getOrCreate: vi.fn().mockRejectedValue(new Error('github-token vercel-token leaked')),
        get: vi.fn(),
        list: vi.fn(),
      } as never,
    });

    await expect(client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'redaction-test',
      image: TEST_IMAGE_REFERENCE,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeout: 10_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: {},
    })).rejects.toThrow('[REDACTED] [REDACTED] leaked');
  });

  it('rejects direct create requests whose image is not a fully-qualified digest', async () => {
    const client = createVercelSandboxClient({
      sandbox: { getOrCreate: vi.fn(), get: vi.fn(), list: vi.fn() } as never,
    });

    await expect(client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'wrong-image',
      image: 'vcr.vercel.com/other/team/image@sha256:wrong',
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeout: 10_000,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: {},
    })).rejects.toThrow(/sha256:<64 hex digits>/);
  });

  it('refuses a floating tag so only a resolved digest can create a Sandbox', () => {
    expect(() => buildVercelSandboxCreateRequest({
      name: 'devbox-vercel-repo-main',
      image: 'vcr.vercel.com/astro-labs/devbox/devbox:nightly',
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeoutMs: 1_800_000,
      tags: {},
    })).toThrow(/sha256:<64 hex digits>/);
  });

  it('builds the v3 persistent Git source request without a runtime field', () => {
    const request = buildVercelSandboxCreateRequest({
      name: 'devbox-vercel-repo-main',
      image: TEST_IMAGE_REFERENCE,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      timeoutMs: 1_800_000,
      tags: {
        provider: 'vercel',
        repository: 'github-com-acme-repo',
        branch: 'main',
        version: 'v-0-1-2',
        identity: 'identity',
      },
    });

    expect(request).toMatchObject({
      name: 'devbox-vercel-repo-main',
      image: TEST_IMAGE_REFERENCE,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'main',
        username: 'x-access-token',
        password: 'github-token',
      },
      persistent: true,
      keepLastSnapshots: { count: 1 },
      timeout: 1_800_000,
      tags: {
        provider: 'vercel',
        repository: 'github-com-acme-repo',
        branch: 'main',
        version: 'v-0-1-2',
        identity: 'identity',
      },
    });
    expect('runtime' in request).toBe(false);
    expect(JSON.stringify(request)).not.toContain('vercel-token');
  });
});
