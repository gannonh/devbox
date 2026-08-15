import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVercelMetadataStore } from '../src/providers/vercel/metadata.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import { createVercelLifecycle } from '../src/providers/vercel/lifecycle.js';
import type { GitHubSourcePlan } from '../src/providers/vercel/source.js';
import type { VercelSandboxClient, VercelSandboxHandle } from '../src/providers/vercel/client.js';

const credentials = { token: 'vercel-token', teamId: 'team', projectId: 'project' };
const source: GitHubSourcePlan = {
  remote: {
    host: 'github.com',
    owner: 'acme',
    repository: 'repo',
    canonical: 'github.com/acme/repo',
    url: 'https://github.com/acme/repo.git',
  },
  defaultBranch: 'main',
  requestedBranch: 'feature/new',
  requestedBranchExists: false,
  needsBranchSetup: true,
  source: {
    type: 'git',
    url: 'https://github.com/acme/repo.git',
    revision: 'main',
    username: 'x-access-token',
    password: 'github-token',
  },
  warning: 'remote-only warning',
};

function sandbox(): VercelSandboxHandle {
  const identity = createVercelIdentity({
    remote: source.remote.canonical,
    branch: source.requestedBranch,
    packageVersion: '0.1.2',
  });
  return {
    name: identity.name,
    status: 'running',
    persistent: true,
    image: 'vcr.vercel.com/team/project/image@sha256:digest',
    tags: { ...identity.tags },
    listSessions: async () => [],
    stop: async () => ({ id: 'session', status: 'stopped' }),
    delete: async () => {},
    runCommand: async () => ({ exitCode: 0 }),
    domain: (port: number) => `https://sandbox.example/${port}`,
  };
}

describe('Vercel lifecycle', () => {
  it('resumes an existing named sandbox without rerunning branch setup', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let creates = 0;
    const client = {
      getOrCreate: vi.fn(async (request) => {
        creates += 1;
        if (creates === 1) await request.onCreate?.(handle);
        return handle;
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    });

    await lifecycle.up();
    await lifecycle.up();

    expect(client.getOrCreate).toHaveBeenCalledTimes(2);
    expect(client.runCommand).toHaveBeenCalledOnce();
  });

  it('serializes concurrent up calls through the metadata lease', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let creates = 0;
    const client = {
      getOrCreate: vi.fn(async (request) => {
        creates += 1;
        if (creates === 1) {
          await request.onCreate?.(handle);
          await createGate;
        }
        return handle;
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    });
    const first = lifecycle.up();
    await vi.waitFor(() => expect(client.getOrCreate).toHaveBeenCalledOnce());
    const second = lifecycle.up();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.getOrCreate).toHaveBeenCalledOnce();
    releaseCreate();
    await Promise.all([first, second]);
    expect(client.getOrCreate).toHaveBeenCalledTimes(2);
    expect(client.runCommand).toHaveBeenCalledOnce();
  });

  it('rejects create-only timeout conflicts without mutating the named sandbox', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox() as VercelSandboxHandle & { timeout: number };
    handle.timeout = 1_800_000;
    const client = {
      getOrCreate: vi.fn(async () => handle),
    } as unknown as VercelSandboxClient;
    const common = {
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    } as const;
    await createVercelLifecycle(common).up();

    await expect(createVercelLifecycle({ ...common, timeoutMs: 1_000 }).up())
      .rejects.toMatchObject({ code: 'identity_conflict' });
    expect(client.getOrCreate).toHaveBeenCalledOnce();
  });

  it('rejects tampered metadata identity before list or cleanup', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async () => handle),
      listSandboxes: vi.fn(async () => []),
      get: vi.fn(async () => handle),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    });
    await lifecycle.up();
    const stored = (await metadata.read())!;
    await metadata.write({
      teamId: stored.teamId,
      projectId: stored.projectId,
      identity: { ...stored.identity!, branch: 'tampered' },
      configuration: stored.configuration,
    });

    await expect(lifecycle.list()).rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(lifecycle.remove()).rejects.toMatchObject({ code: 'identity_conflict' });
    expect(client.listSandboxes).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('retains non-secret residual metadata when cleanup is partial', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let deleted = false;
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return handle;
      }),
      listSessions: vi.fn(async () => [{ id: 'session-1', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session-1', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => [{ id: 'snapshot-failed', sourceSessionId: 'session-1', status: 'failed' as const }]),
      getSnapshot: vi.fn(async () => { throw new Error('snapshot deletion blocked'); }),
      deleteSandbox: vi.fn(async () => { deleted = true; }),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });
    await lifecycle.up();

    await expect(lifecycle.remove()).rejects.toMatchObject({
      name: 'VercelCleanupError',
      code: 'cleanup_incomplete',
    });
    const retained = await metadata.read();
    expect(retained).toMatchObject({
      teamId: 'team',
      projectId: 'project',
      residual: {
        snapshotIds: ['snapshot-failed'],
      },
    });
    expect(JSON.stringify(retained)).not.toContain('vercel-token');
  });

  it('removes the sandbox only after verified cleanup and then removes metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let deleted = false;
    let snapshots = [{ id: 'snapshot-1', sourceSessionId: 'session-1', status: 'created' as const }];
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return handle;
      }),
      listSessions: vi.fn(async () => [{ id: 'session-1', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session-1', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => snapshots),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'snapshot-1',
        status: 'created' as const,
        delete: async () => { snapshots = []; },
      })),
      deleteSnapshot: vi.fn(async () => {}),
      deleteSandbox: vi.fn(async () => { deleted = true; }),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
      cleanup: { maxAttempts: 2, sleep: async () => {} },
    });
    await lifecycle.up();

    await expect(lifecycle.remove()).resolves.toMatchObject({ verified: true });
    expect(client.stopSandbox).toHaveBeenCalledOnce();
    expect(client.deleteSandbox).toHaveBeenCalledOnce();
    expect(client.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      snapshotId: 'snapshot-1',
    }));
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('lists only matching provider and repository identity tags', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const records = [
      { name: handle.name, status: 'running' as const, tags: handle.tags },
      { name: 'other-provider', status: 'running' as const, tags: { ...handle.tags, provider: 'local' } },
      { name: 'other-repo', status: 'running' as const, tags: { ...handle.tags, repository: 'other' } },
    ];
    const client = {
      getOrCreate: vi.fn(async () => handle),
      listSandboxes: vi.fn(async () => records),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    });
    await lifecycle.up();

    await expect(lifecycle.list()).resolves.toEqual([records[0]]);
    expect(client.listSandboxes).toHaveBeenCalledWith({
      credentials,
      tags: { provider: 'vercel', repository: handle.tags?.repository },
    });
  });

  it('attaches to matching routes and rejects an unconfigured URL port', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox() as VercelSandboxHandle & { routes: { url: string; subdomain: string; port: number }[] };
    handle.routes = [{ url: 'https://sandbox.example/3000', subdomain: 'sandbox', port: 3000 }];
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => handle),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    });
    await lifecycle.up();

    await expect(lifecycle.routes()).resolves.toEqual(handle.routes);
    await expect(lifecycle.url(3000)).resolves.toBe('https://sandbox.example/3000');
    await expect(lifecycle.url(8080)).rejects.toMatchObject({ code: 'route_not_found' });
  });

  it('stops persistent sandboxes and returns final usage without secrets', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let sessionsRead = 0;
    const client = {
      getOrCreate: vi.fn(async (request) => {
        await request.onCreate?.(handle);
        return handle;
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => {
        sessionsRead += 1;
        return [{
          id: 'session-1',
          status: sessionsRead === 1 ? 'running' as const : 'stopped' as const,
          activeCpuDurationMs: 123,
          networkTransfer: { ingress: 4, egress: 5 },
        }];
      }),
      stopSandbox: vi.fn(async () => ({
        id: 'session-1',
        status: 'stopped' as const,
        activeCpuDurationMs: 123,
        networkTransfer: { ingress: 4, egress: 5 },
        snapshot: { id: 'snapshot-1', status: 'created' as const },
      })),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    });
    await lifecycle.up();

    const report = await lifecycle.stop();

    expect(client.get).toHaveBeenCalledWith({
      credentials,
      name: handle.name,
      resume: false,
    });
    expect(client.stopSandbox).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      name: handle.name,
      snapshot: { id: 'snapshot-1', status: 'created' },
      activeCpuUsageMs: 123,
      networkTransfer: { ingress: 4, egress: 5 },
    });
    expect(JSON.stringify(report)).not.toContain('vercel-token');
    await expect(metadata.read()).resolves.toMatchObject({ snapshotIds: ['snapshot-1'] });
  });

  it('fails an existing sandbox identity conflict instead of mutating it', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    handle.tags = { ...handle.tags, identity: 'different' };
    const client = {
      getOrCreate: vi.fn(async () => handle),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
    });

    await expect(lifecycle.up()).rejects.toMatchObject({
      name: 'VercelIdentityConflictError',
      code: 'identity_conflict',
    });
    expect(client.runCommand).not.toHaveBeenCalled();
  });

  it('creates a named persistent sandbox and switches only a missing remote branch', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const requests: unknown[] = [];
    const client = {
      getOrCreate: vi.fn(async (request) => {
        requests.push(request);
        await request.onCreate?.(handle);
        return handle;
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as VercelSandboxClient;
    const notices: string[] = [];

    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
      onNotice: (notice) => notices.push(notice),
    });

    await expect(lifecycle.up()).resolves.toBe(handle);
    expect(notices).toEqual([source.warning]);
    expect(client.runCommand).toHaveBeenCalledWith(
      handle,
      'git',
      ['switch', '--create', source.requestedBranch, '--'],
    );
    expect(requests[0]).toMatchObject({
      name: handle.name,
      image: 'vcr.vercel.com/team/project/image@sha256:digest',
      source: { revision: 'main' },
      persistent: true,
      keepLastSnapshots: { count: 1 },
      tags: source.remote && expect.any(Object),
    });
    expect('runtime' in (requests[0] as object)).toBe(false);
    await expect(metadata.read()).resolves.toMatchObject({
      teamId: 'team',
      projectId: 'project',
      identity: expect.objectContaining({ branch: source.requestedBranch }),
      configuration: expect.objectContaining({
        sourceRevision: 'main',
        needsBranchSetup: true,
      }),
    });
  });
});
