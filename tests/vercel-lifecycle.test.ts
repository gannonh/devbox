import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVercelBranchMetadataStore,
  createVercelMetadataStore,
} from '../src/providers/vercel/metadata.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import {
  createVercelLifecycle,
  VercelLifecycleError,
} from '../src/providers/vercel/lifecycle.js';
import { VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
import type { GitHubSourcePlan } from '../src/providers/vercel/source.js';
import {
  createVercelSandboxClient,
  VercelSdkError,
  type VercelSandboxClient,
  type VercelSandboxHandle,
} from '../src/providers/vercel/client.js';

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
    cwd: '/vercel/sandbox',
    persistent: true,
    image: VERCEL_IMAGE_PIN.reference,
    tags: { ...identity.tags },
    openInteractive: async () => ({ url: 'wss://sandbox.example/session', token: 'token' }),
    extendTimeout: async () => {},
    listSessions: async () => [],
    stop: async () => ({ id: 'session', status: 'stopped' }),
    delete: async () => {},
    runCommand: async () => ({ exitCode: 0 }),
    domain: (port: number) => `https://sandbox.example/${port}`,
  };
}

describe('Vercel lifecycle', () => {
  it('uses scope-aware branch metadata and refuses mismatched delete tags', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-branch-'));
    const branchMetadataStore = createVercelBranchMetadataStore({
      stateHome,
      repoKey: source.remote.canonical,
      branch: source.requestedBranch,
    });
    const scopedIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    await branchMetadataStore.write({
      identity: {
        name: scopedIdentity.name,
        repository: scopedIdentity.canonicalRepository,
        branch: scopedIdentity.branch,
        packageVersion: scopedIdentity.packageVersion,
        tags: {
          provider: scopedIdentity.tags.provider,
          repository: scopedIdentity.tags.repository,
          branch: scopedIdentity.tags.branch,
          version: scopedIdentity.tags.version,
          identity: scopedIdentity.tags.identity,
        },
      },
    });
    const handle = sandbox();
    Object.defineProperty(handle, 'name', { value: scopedIdentity.name });
    Object.defineProperty(handle, 'tags', { value: { ...scopedIdentity.tags, identity: 'tampered' } });
    const deleted = vi.fn();
    const client = {
      get: vi.fn(async () => handle),
      deleteSandbox: deleted,
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      branchMetadataStore,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(lifecycle.remove()).rejects.toMatchObject({ code: 'cleanup_incomplete' });
    expect(deleted).not.toHaveBeenCalled();
    await expect(branchMetadataStore.read()).resolves.toMatchObject({
      identity: { tags: { identity: scopedIdentity.tags.identity } },
      residual: { reason: expect.any(String) },
    });
  });

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
    });

    await lifecycle.up();
    await lifecycle.up();

    expect(client.getOrCreate).toHaveBeenCalledTimes(2);
    expect(client.runCommand).toHaveBeenCalledOnce();
  });

  it('preserves snapshot retry seeds and residual audit state after partial cleanup', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(async ({ snapshotId }) => { throw new Error(`delete blocked for ${snapshotId}`); }),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await lifecycle.up();
    const stored = (await metadata.read())!;
    await metadata.write({
      teamId: stored.teamId,
      projectId: stored.projectId,
      identity: stored.identity,
      sandboxId: stored.sandboxId,
      snapshotIds: ['retry-seed'],
      configuration: stored.configuration,
    });

    await expect(lifecycle.remove()).rejects.toMatchObject({ code: 'cleanup_incomplete' });
    const partial = (await metadata.read())!;
    expect(partial.snapshotIds).toEqual(['retry-seed']);
    expect(partial.residual).toEqual(expect.objectContaining({
      snapshotIds: ['retry-seed'],
    }));

    await lifecycle.up();
    const resumed = (await metadata.read())!;
    expect(resumed.snapshotIds).toEqual(partial.snapshotIds);
    expect(resumed.residual).toEqual(partial.residual);
  });

  it('preserves branch setup lifecycle errors through the SDK adapter', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const target = sandbox();
    target.runCommand = async () => ({
      exitCode: 1,
      stderr: async () => 'branch setup failed with github-token',
    });
    const sandboxApi = {
      getOrCreate: vi.fn(async (params: Record<string, unknown>) => {
        await (params.onCreate as ((sandbox: VercelSandboxHandle) => Promise<void>))(target);
        return target;
      }),
      get: vi.fn(),
      list: vi.fn(),
    };
    const client = createVercelSandboxClient({ sandbox: sandboxApi });
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
    });

    let caught: unknown;
    try {
      await lifecycle.up();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VercelLifecycleError);
    expect(caught).not.toBeInstanceOf(VercelSdkError);
    expect(caught).toMatchObject({
      name: 'VercelLifecycleError',
      code: 'branch_setup_failed',
    });
    expect((caught as Error).message).toContain('Unable to create requested Git branch');
    expect((caught as Error).message).not.toContain('github-token');
  });

  it('records a possible sandbox residual when the initial lookup fails', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => { throw Object.assign(new Error('Vercel unavailable'), { status: 503 }); }),
      listSessions: vi.fn(),
      stopSandbox: vi.fn(),
      listSnapshots: vi.fn(),
      getSnapshot: vi.fn(),
      deleteSandbox: vi.fn(),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });
    await lifecycle.up();

    await expect(lifecycle.remove()).rejects.toMatchObject({ code: 'cleanup_incomplete' });
    await expect(metadata.read()).resolves.toMatchObject({
      residual: { sandboxIds: [handle.name] },
    });
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it.each(['failed', 'running'] as const)('fails stop_incomplete for a non-converging %s session', async (status) => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'stuck-session', status }]),
      stopSandbox: vi.fn(async () => ({ id: 'stuck-session', status })),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
    });
    await lifecycle.up();

    await expect(lifecycle.stop()).rejects.toMatchObject({
      name: 'VercelLifecycleError',
      code: 'stop_incomplete',
    });
    expect(client.stopSandbox).toHaveBeenCalledOnce();
    await expect(metadata.read()).resolves.toMatchObject({ identity: expect.any(Object) });
  });

  it('resumes after remote branch state changes without changing bootstrap configuration', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const laterSource: GitHubSourcePlan = {
      ...source,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: { ...source.source, revision: source.requestedBranch },
    };
    let creates = 0;
    const client = {
      getOrCreate: vi.fn(async (request) => {
        creates += 1;
        if (creates === 1) await request.onCreate?.(handle);
        return handle;
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
    } as unknown as VercelSandboxClient;
    await createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
    }).up();

    const laterLifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: laterSource.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source: laterSource,
      metadataStore: metadata,
      client,
    });
    await expect(laterLifecycle.up()).resolves.toBe(handle);
    await laterLifecycle.stop();

    expect(client.getOrCreate).toHaveBeenCalledTimes(2);
    expect(client.runCommand).toHaveBeenCalledOnce();
    await expect(metadata.read()).resolves.toMatchObject({
      configuration: {
        sourceRevision: 'main',
        needsBranchSetup: true,
      },
    });

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

  it('retains metadata until a stale named sandbox deletion is verified', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let deleteAttempts = 0;
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => { throw Object.assign(new Error('snapshot_not_found'), { status: 410 }); }),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteSandboxByName: vi.fn(async () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error('delete unavailable');
        return { missing: false };
      }),
      listSessions: vi.fn(async () => []),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });
    await lifecycle.up();

    await expect(lifecycle.remove()).rejects.toMatchObject({ code: 'cleanup_incomplete' });
    await expect(metadata.read()).resolves.toMatchObject({
      residual: { sandboxIds: [handle.name] },
    });
    expect(client.stopSandbox).not.toHaveBeenCalled();
    expect(client.deleteSandbox).not.toHaveBeenCalled();

    await expect(lifecycle.remove()).resolves.toMatchObject({ verified: true });
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('retains metadata and performs no destructive action when remove finds mismatched tags', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async () => handle),
      get: vi.fn(async () => ({ ...handle, tags: { ...handle.tags, identity: 'wrong-identity' } })),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'running' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });
    await lifecycle.up();

    await expect(lifecycle.remove()).rejects.toMatchObject({
      name: 'VercelCleanupError',
      code: 'cleanup_incomplete',
    });
    expect(client.stopSandbox).not.toHaveBeenCalled();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
    await expect(metadata.read()).resolves.toMatchObject({
      identity: expect.objectContaining({ tags: handle.tags }),
      residual: expect.objectContaining({ sandboxIds: [handle.name] }),
    });
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

  it('seeds remove cleanup from stored snapshot IDs before relisting', async () => {
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
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'metadata-snapshot',
        status: 'created' as const,
        delete: async () => {},
      })),
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
      cleanup: { maxAttempts: 3, sleep: async () => {} },
    });
    await lifecycle.up();
    const stored = (await metadata.read())!;
    await metadata.write({
      teamId: stored.teamId,
      projectId: stored.projectId,
      identity: stored.identity,
      sandboxId: stored.sandboxId,
      snapshotIds: ['metadata-snapshot'],
      configuration: stored.configuration,
    });

    await expect(lifecycle.remove()).resolves.toMatchObject({ verified: true });
    expect(client.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: 'metadata-snapshot' }));
    await expect(metadata.read()).resolves.toBeNull();
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
      cleanup: { maxAttempts: 3, sleep: async () => {} },
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
      {
        name: 'other-branch',
        status: 'running' as const,
        tags: { ...handle.tags, branch: 'other-branch', version: 'v-other', identity: 'other-id' },
      },
      { name: 'other-provider', status: 'running' as const, tags: { ...handle.tags, provider: 'local' } },
      { name: 'other-repo', status: 'running' as const, tags: { ...handle.tags, repository: 'other' } },
      {
        name: 'missing-identity-tag',
        status: 'running' as const,
        tags: {
          provider: handle.tags?.provider,
          repository: handle.tags?.repository,
          branch: 'other-branch',
          version: 'v-other',
        },
      },
      {
        name: 'empty-identity-tag',
        status: 'running' as const,
        tags: { ...handle.tags, identity: '' },
      },
      {
        name: 'extra-identity-tag',
        status: 'running' as const,
        tags: { ...handle.tags, extra: 'not-allowed' },
      },
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
    });
    await lifecycle.up();

    await expect(lifecycle.list()).resolves.toEqual([records[0], records[1]]);
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
        if (sessionsRead === 1) {
          return [{
            id: 'session-1',
            status: 'running' as const,
            activeCpuDurationMs: 123,
            networkTransfer: { ingress: 4, egress: 5 },
          }];
        }
        return [
          { id: 'newest-session', status: 'stopped' as const, requestedAt: 200, createdAt: 200 },
          { id: 'older-session', status: 'stopped' as const, requestedAt: 100, createdAt: 100 },
        ];
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
      finalSession: { id: 'newest-session' },
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
      onNotice: (notice) => notices.push(notice),
    });

    await expect(lifecycle.up()).resolves.toBe(handle);
    expect(notices).toEqual([source.warning]);
    expect(client.runCommand).toHaveBeenCalledWith(handle, {
      cmd: 'git',
      args: ['switch', '--create', source.requestedBranch, '--'],
      cwd: '/vercel/sandbox/repo',
    });
    expect(requests[0]).toMatchObject({
      name: handle.name,
      image: VERCEL_IMAGE_PIN.reference,
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
