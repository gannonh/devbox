import { describe, expect, it, vi } from 'vitest';
import { Sandbox as MockSandbox, Snapshot as MockSnapshot } from '@vercel/sandbox-mock';
import {
  buildVercelSandboxCreateRequest,
  createVercelSandboxClient,
} from '../src/providers/vercel/client.js';

describe('Vercel Sandbox client adapter', () => {
  it('uses the real SDK classes through the sandbox-mock lifecycle boundary', async () => {
    const client = createVercelSandboxClient({
      sandbox: MockSandbox as never,
      snapshot: MockSnapshot as never,
    });
    const handle = await client.getOrCreate({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'mock-client-adapter',
      image: 'vercel/sandbox/universal:latest',
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
    const attached = await client.get({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'mock-client-adapter',
      resume: false,
    });
    expect(attached.name).toBe('mock-client-adapter');
    await expect(client.listSnapshots({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'mock-client-adapter',
    })).resolves.toEqual([]);
    await client.deleteSandbox(attached);
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
      image: 'vcr.vercel.com/team/project/image@sha256:digest',
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
      image: 'vcr.vercel.com/team/project/image@sha256:digest',
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
      image: 'image',
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

  it('builds the v3 persistent Git source request without a runtime field', () => {
    const request = buildVercelSandboxCreateRequest({
      credentials: { token: 'vercel-token', teamId: 'team', projectId: 'project' },
      name: 'devbox-vercel-repo-main',
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
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
      image: 'vcr.vercel.com/team/project/image@sha256:digest',
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
