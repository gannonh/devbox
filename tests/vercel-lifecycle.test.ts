import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVercelBranchMetadataStore,
  createVercelMetadataStore,
  type VercelBranchMetadataStore,
} from '../src/providers/vercel/metadata.js';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import {
  createVercelLifecycle,
  DEFAULT_VERCEL_SANDBOX_TIMEOUT_MS,
  VercelLifecycleError,
} from '../src/providers/vercel/lifecycle.js';
import { parseVercelImageReference, VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
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
  it('keeps stop, remove, and list working when devcontainer ports are malformed', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-malformed-'));
    await mkdir(join(repoRoot, '.devcontainer'));
    await writeFile(join(repoRoot, '.devcontainer', 'devcontainer.json'), '{ "forwardPorts": [ }');
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-malformed-state-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const identity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
    });
    await metadata.write({
      teamId: credentials.teamId,
      projectId: credentials.projectId,
      identity: {
        name: identity.name,
        repository: identity.canonicalRepository,
        branch: identity.branch,
        packageVersion: identity.packageVersion,
        tags: { ...identity.tags },
      },
      sandboxId: handle.name,
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
        sourceUrl: source.source.url,
        sourceRevision: source.source.revision,
        requestedBranch: source.requestedBranch,
        needsBranchSetup: source.needsBranchSetup,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: DEFAULT_VERCEL_SANDBOX_TIMEOUT_MS,
      },
    });
    let deleted = false;
    const client = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return handle;
      }),
      getOrCreate: vi.fn(async () => handle),
      listSandboxes: vi.fn(async () => [{
        name: handle.name,
        persistent: true,
        status: 'running' as const,
        image: VERCEL_IMAGE_PIN.reference,
        tags: { ...identity.tags },
      }]),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      deleteSandbox: vi.fn(async () => { deleted = true; }),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      metadataStore: metadata,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(lifecycle.stop()).resolves.toMatchObject({ name: handle.name });
    await expect(lifecycle.list()).resolves.toEqual([
      expect.objectContaining({ name: handle.name }),
    ]);
    await expect(lifecycle.remove()).resolves.toMatchObject({ verified: true });
    await expect(lifecycle.up()).rejects.toThrow(/devcontainer\.json.*invalid JSONC.*line/);
  });

  it('fails closed when a returned Sandbox omits its image before metadata persistence', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-image-missing-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const write = vi.spyOn(metadata, 'write');
    const handle = { ...sandbox(), image: undefined } as unknown as VercelSandboxHandle;
    const client = {
      getOrCreate: vi.fn(async () => handle),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source: { ...source, requestedBranchExists: true, needsBranchSetup: false, source: { ...source.source, revision: source.requestedBranch } },
      metadataStore: metadata,
      client,
    });

    await expect(lifecycle.up()).rejects.toMatchObject({ code: 'identity_conflict' });
    expect(client.getOrCreate).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('accepts an alternate Sandbox image serialization when the digest matches', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-image-digest-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const digest = parseVercelImageReference(VERCEL_IMAGE_PIN.reference).digest;
    const handle = { ...sandbox(), image: `alternate.registry/devbox@${digest}` } as VercelSandboxHandle;
    const client = {
      getOrCreate: vi.fn(async () => handle),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source: { ...source, requestedBranchExists: true, needsBranchSetup: false, source: { ...source.source, revision: source.requestedBranch } },
      metadataStore: metadata,
      client,
    });

    await expect(lifecycle.up()).resolves.toBe(handle);
    await expect(metadata.read()).resolves.toMatchObject({ identity: { name: handle.name } });
  });

  it('compensates a newly created sandbox when branch setup fails during onCreate', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-branch-compensation-verified-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let deleted = false;
    const client = {
      getOrCreate: vi.fn(async (request) => {
        await request.onCreate?.(handle);
        return handle;
      }),
      runCommand: vi.fn(async () => ({
        exitCode: 1,
        stderr: async () => 'branch setup failed',
      })),
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return handle;
      }),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
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

    await expect(lifecycle.up()).rejects.toMatchObject({ code: 'branch_setup_failed' });
    expect(client.deleteSandbox).toHaveBeenCalledOnce();
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('retains recovery state when branch setup compensation is incomplete', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-branch-compensation-incomplete-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async (request) => {
        await request.onCreate?.(handle);
        return handle;
      }),
      runCommand: vi.fn(async () => ({
        exitCode: 1,
        stderr: async () => 'branch setup failed',
      })),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => { throw new Error('sandbox delete unavailable'); }),
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

    const caught = await lifecycle.up().catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: 'cleanup_incomplete',
      result: {
        verified: false,
        residualSandboxIds: [handle.name],
      },
    });
    expect((caught as Error).message).toContain(handle.name);
    await expect(metadata.read()).resolves.toMatchObject({
      residual: {
        sandboxIds: [handle.name],
      },
    });
  });

  it('compensates a newly created sandbox when metadata persistence fails', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-compensation-verified-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const persistenceError = new Error('initial metadata write failed');
    vi.spyOn(metadata, 'write').mockRejectedValue(persistenceError);
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async (request) => {
        await request.onCreate?.(handle);
        return handle;
      }),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const noSetupSource = {
      ...source,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: { ...source.source, revision: source.requestedBranch },
    };
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source: noSetupSource,
      metadataStore: metadata,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(lifecycle.up()).rejects.toBe(persistenceError);
    expect(client.deleteSandbox).toHaveBeenCalledOnce();
    expect(await metadata.read()).toBeNull();
  });

  it('retains nonsecret recovery guidance when created-sandbox compensation is incomplete', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-compensation-incomplete-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const persistenceError = new Error('metadata write failed with vercel-token');
    const recoveryWrites: unknown[] = [];
    vi.spyOn(metadata, 'write')
      .mockRejectedValueOnce(persistenceError)
      .mockImplementation(async (input) => { recoveryWrites.push(input); });
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async (request) => {
        await request.onCreate?.(handle);
        return handle;
      }),
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => { throw new Error('sandbox delete unavailable'); }),
    } as unknown as VercelSandboxClient;
    const noSetupSource = {
      ...source,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: { ...source.source, revision: source.requestedBranch },
    };
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source: noSetupSource,
      metadataStore: metadata,
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    const caught = await lifecycle.up().catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: 'cleanup_incomplete',
      result: {
        verified: false,
        residualSandboxIds: [handle.name],
      },
    });
    expect(JSON.stringify(caught)).not.toContain('vercel-token');
    expect(recoveryWrites).toHaveLength(1);
    expect(recoveryWrites[0]).toMatchObject({
      residual: {
        sandboxIds: [handle.name],
        reason: expect.stringContaining('metadata'),
      },
    });
    expect(JSON.stringify(recoveryWrites)).not.toContain('vercel-token');
  });

  it('does not compensate a preexisting sandbox when its metadata write fails', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-compensation-existing-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const persistenceError = new Error('metadata write failed');
    vi.spyOn(metadata, 'write').mockRejectedValue(persistenceError);
    const handle = sandbox();
    const client = {
      getOrCreate: vi.fn(async () => handle),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const noSetupSource = {
      ...source,
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: { ...source.source, revision: source.requestedBranch },
    };
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source: noSetupSource,
      metadataStore: metadata,
      client,
    });

    await expect(lifecycle.up()).rejects.toBe(persistenceError);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it('uses stored old-version identity for every stored lifecycle action', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-old-identity-'));
    const metadata = createVercelBranchMetadataStore({
      stateHome,
      repoKey: source.remote.canonical,
      branch: source.requestedBranch,
    });
    const oldIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.0.1',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    const oldHandle = {
      ...sandbox(),
      name: oldIdentity.name,
      tags: { ...oldIdentity.tags },
      routes: [{ url: 'https://old.example/3000', subdomain: 'old', port: 3000 }],
      domain: () => 'https://old.example/3000',
    } as VercelSandboxHandle;
    await metadata.write({
      identity: {
        name: oldIdentity.name,
        repository: oldIdentity.canonicalRepository,
        branch: oldIdentity.branch,
        packageVersion: oldIdentity.packageVersion,
        tags: { ...oldIdentity.tags },
      },
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
        sourceUrl: source.source.url,
        sourceRevision: source.source.revision,
        requestedBranch: source.requestedBranch,
        needsBranchSetup: source.needsBranchSetup,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });

    const get = vi.fn(async ({ name }: { name: string }) => {
      expect(name).toBe(oldIdentity.name);
      return oldHandle;
    });
    const client = {
      get,
      listSandboxes: vi.fn(async ({ tags }: { tags: Record<string, string> }) => {
        expect(tags).toEqual({ provider: oldIdentity.tags.provider, repository: oldIdentity.tags.repository });
        return [{ name: oldIdentity.name, status: 'stopped' as const, tags: { ...oldIdentity.tags } }];
      }),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stopSandbox: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
      credentials,
      source,
      branchMetadataStore: metadata,
      client,
    });

    await expect(lifecycle.get()).resolves.toBe(oldHandle);
    await expect(lifecycle.attach()).resolves.toBe(oldHandle);
    await expect(lifecycle.routes()).resolves.toEqual(oldHandle.routes);
    await expect(lifecycle.url(3000)).resolves.toBe('https://old.example/3000');
    await expect(lifecycle.list()).resolves.toEqual([
      expect.objectContaining({ name: oldIdentity.name }),
    ]);
    await expect(lifecycle.stop()).resolves.toMatchObject({ name: oldIdentity.name });
    await expect(lifecycle.remove()).resolves.toMatchObject({ verified: true });

    expect(get).toHaveBeenCalled();
    expect(get.mock.calls.every(([request]) => request.name === oldIdentity.name)).toBe(true);
    expect(client.deleteSandbox).toHaveBeenCalledWith(oldHandle, expect.anything());
    await expect(metadata.read()).resolves.toBeNull();
  });

  it('uses stored identity for up resume and current identity for new creation', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-up-identity-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const oldIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.0.1',
    });
    const currentIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
    });
    const oldHandle = { ...sandbox(), name: oldIdentity.name, tags: { ...oldIdentity.tags } } as VercelSandboxHandle;
    const currentHandle = { ...sandbox(), name: currentIdentity.name, tags: { ...currentIdentity.tags } } as VercelSandboxHandle;
    await metadata.write({
      teamId: credentials.teamId,
      projectId: credentials.projectId,
      identity: {
        name: oldIdentity.name,
        repository: oldIdentity.canonicalRepository,
        branch: oldIdentity.branch,
        packageVersion: oldIdentity.packageVersion,
        tags: { ...oldIdentity.tags },
      },
      configuration: {
        imageReference: VERCEL_IMAGE_PIN.reference,
        sourceUrl: source.source.url,
        sourceRevision: source.source.revision,
        requestedBranch: source.requestedBranch,
        needsBranchSetup: source.needsBranchSetup,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });

    const requests: Array<{ name: string; tags: Record<string, string> }> = [];
    const client = {
      getOrCreate: vi.fn(async (request: { name: string; tags: Record<string, string> }) => {
        requests.push({ name: request.name, tags: { ...request.tags } });
        return requests.length === 1 ? oldHandle : currentHandle;
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

    await expect(lifecycle.up()).resolves.toBe(oldHandle);
    expect(requests[0]).toEqual({ name: oldIdentity.name, tags: { ...oldIdentity.tags } });
    await expect(metadata.read()).resolves.toMatchObject({ identity: { packageVersion: '0.0.1', name: oldIdentity.name } });

    await metadata.remove();
    await expect(lifecycle.up()).resolves.toBe(currentHandle);
    expect(requests[1]).toEqual({ name: currentIdentity.name, tags: { ...currentIdentity.tags } });
    await expect(metadata.read()).resolves.toMatchObject({ identity: { packageVersion: '0.1.2', name: currentIdentity.name } });
  });

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

  it('removes an authoritative recovered sandbox when branch metadata persistence is unavailable', async () => {
    const recoveredIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
    });
    const handle = {
      ...sandbox(),
      name: recoveredIdentity.name,
      status: 'stopped' as const,
      tags: { ...recoveredIdentity.tags },
    };
    const branchMetadataStore = {
      path: '/unavailable/branch.json',
      lockPath: '/unavailable/branch.lock',
      repoKey: source.remote.canonical,
      branch: source.requestedBranch,
      read: vi.fn(async () => { throw new Error('metadata read unavailable'); }),
      write: vi.fn(async () => { throw new Error('metadata write unavailable'); }),
      remove: vi.fn(async () => { throw new Error('metadata remove unavailable'); }),
      acquireLock: vi.fn(),
      withLock: vi.fn(async () => { throw new Error('metadata lock unavailable'); }),
    } as unknown as VercelBranchMetadataStore;
    const client = {
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'recovered-snapshot',
        status: 'created' as const,
        delete: async () => {},
      })),
      deleteSandbox: vi.fn(async () => {}),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      credentials,
      source,
      branchMetadataStore,
      recovery: {
        identity: {
          name: recoveredIdentity.name,
          repository: recoveredIdentity.canonicalRepository,
          branch: recoveredIdentity.branch,
          packageVersion: recoveredIdentity.packageVersion,
          tags: { ...recoveredIdentity.tags },
        },
        snapshotIds: ['recovered-snapshot'],
      },
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(lifecycle.remove()).resolves.toMatchObject({ verified: true });
    expect(client.deleteSandbox).toHaveBeenCalledOnce();
    expect(branchMetadataStore.read).not.toHaveBeenCalled();
    expect(branchMetadataStore.write).not.toHaveBeenCalled();
    expect(branchMetadataStore.withLock).not.toHaveBeenCalled();
  });

  it('fails recovered cleanup closed when the fetched sandbox tags are tampered', async () => {
    const recoveredIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
    });
    const handle = {
      ...sandbox(),
      name: recoveredIdentity.name,
      status: 'stopped' as const,
      tags: { ...recoveredIdentity.tags, identity: 'tampered' },
    };
    const deleted = vi.fn();
    const branchMetadataStore = {
      path: '/recovery/branch.json',
      lockPath: '/recovery/branch.lock',
      repoKey: source.remote.canonical,
      branch: source.requestedBranch,
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      acquireLock: vi.fn(),
      withLock: vi.fn(async () => { throw new Error('metadata lock unavailable'); }),
    } as unknown as VercelBranchMetadataStore;
    const client = {
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: deleted,
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      credentials,
      source,
      branchMetadataStore,
      recovery: {
        identity: {
          name: recoveredIdentity.name,
          repository: recoveredIdentity.canonicalRepository,
          branch: recoveredIdentity.branch,
          packageVersion: recoveredIdentity.packageVersion,
          tags: { ...recoveredIdentity.tags },
        },
      },
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    await expect(lifecycle.remove()).rejects.toMatchObject({
      code: 'cleanup_incomplete',
      result: { verified: false },
    });
    expect(deleted).not.toHaveBeenCalled();
  });

  it('keeps concurrent recovered removals idempotent without acquiring metadata locks', async () => {
    const recoveredIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
    });
    let deleted = false;
    const handle = {
      ...sandbox(),
      name: recoveredIdentity.name,
      status: 'stopped' as const,
      tags: { ...recoveredIdentity.tags },
    };
    const branchMetadataStore = {
      path: '/unavailable/branch.json',
      lockPath: '/unavailable/branch.lock',
      repoKey: source.remote.canonical,
      branch: source.requestedBranch,
      read: vi.fn(async () => { throw new Error('metadata read unavailable'); }),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      acquireLock: vi.fn(),
      withLock: vi.fn(async () => { throw new Error('metadata lock unavailable'); }),
    } as unknown as VercelBranchMetadataStore;
    const client = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return handle;
      }),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => { deleted = true; }),
    } as unknown as VercelSandboxClient;
    const lifecycleOptions = {
      repoRoot: '/repo',
      branch: source.requestedBranch,
      credentials,
      source,
      branchMetadataStore,
      recovery: {
        identity: {
          name: recoveredIdentity.name,
          repository: recoveredIdentity.canonicalRepository,
          branch: recoveredIdentity.branch,
          packageVersion: recoveredIdentity.packageVersion,
          tags: { ...recoveredIdentity.tags },
        },
      },
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    } as const;

    const [first, second] = await Promise.all([
      createVercelLifecycle(lifecycleOptions).remove(),
      createVercelLifecycle(lifecycleOptions).remove(),
    ]);

    expect(first.verified).toBe(true);
    expect(second.verified).toBe(true);
    expect(client.deleteSandbox).toHaveBeenCalled();
    expect(branchMetadataStore.withLock).not.toHaveBeenCalled();
  });

  it('retains redacted residual guidance when recovered cleanup persistence fails', async () => {
    const token = 'recovered-metadata-secret';
    const recoveredIdentity = createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      packageVersion: '0.1.2',
    });
    const handle = {
      ...sandbox(),
      name: recoveredIdentity.name,
      status: 'stopped' as const,
      tags: { ...recoveredIdentity.tags },
    };
    const branchMetadataStore = {
      path: '/unavailable/branch.json',
      lockPath: '/unavailable/branch.lock',
      repoKey: source.remote.canonical,
      branch: source.requestedBranch,
      read: vi.fn(async () => { throw new Error('metadata read unavailable'); }),
      write: vi.fn(async () => { throw new Error(`metadata write failed with ${token}`); }),
      remove: vi.fn(async () => {}),
      acquireLock: vi.fn(),
      withLock: vi.fn(async () => { throw new Error('metadata lock unavailable'); }),
    } as unknown as VercelBranchMetadataStore;
    const client = {
      get: vi.fn(async () => handle),
      listSessions: vi.fn(async () => []),
      listSnapshots: vi.fn(async () => []),
      deleteSandbox: vi.fn(async () => { throw new Error(`sandbox delete failed with ${token}`); }),
    } as unknown as VercelSandboxClient;
    const lifecycle = createVercelLifecycle({
      repoRoot: '/repo',
      branch: source.requestedBranch,
      credentials: { ...credentials, token },
      source,
      branchMetadataStore,
      recovery: {
        identity: {
          name: recoveredIdentity.name,
          repository: recoveredIdentity.canonicalRepository,
          branch: recoveredIdentity.branch,
          packageVersion: recoveredIdentity.packageVersion,
          tags: { ...recoveredIdentity.tags },
        },
      },
      client,
      cleanup: { maxAttempts: 1, sleep: async () => {} },
    });

    const caught = await lifecycle.remove().catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: 'cleanup_incomplete',
      result: {
        verified: false,
        residualSandboxIds: [handle.name],
      },
    });
    expect((caught as Error).message).toContain(handle.name);
    expect((caught as Error).message).toContain('metadata');
    expect((caught as Error).message).not.toContain(token);
    expect(branchMetadataStore.write).toHaveBeenCalledOnce();
    expect(branchMetadataStore.write).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ name: handle.name }),
      sandboxId: handle.name,
      residual: expect.objectContaining({
        sandboxIds: [handle.name],
        reason: expect.any(String),
      }),
    }));
    expect(branchMetadataStore.withLock).not.toHaveBeenCalled();
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

  it('does not compensate a preexisting sandbox when resume getOrCreate fails', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-lifecycle-resume-failure-'));
    const metadata = createVercelMetadataStore({ stateHome, repoKey: source.remote.canonical });
    const handle = sandbox();
    let creates = 0;
    const client = {
      getOrCreate: vi.fn(async (request) => {
        creates += 1;
        if (creates === 1) {
          await request.onCreate?.(handle);
          return handle;
        }
        throw new Error('resume unavailable');
      }),
      runCommand: vi.fn(async () => ({ exitCode: 0 })),
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
    });

    await lifecycle.up();
    await expect(lifecycle.up()).rejects.toThrow('resume unavailable');
    expect(client.runCommand).toHaveBeenCalledOnce();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
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
      listSnapshots: vi.fn(async () => [{
        id: 'retry-seed',
        sourceSessionId: 'session',
        status: 'created' as const,
      }]),
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
      get: vi.fn(async () => target),
      list: vi.fn(),
    };
    const snapshotApi = {
      list: vi.fn(async () => []),
      get: vi.fn(),
    };
    const client = createVercelSandboxClient({ sandbox: sandboxApi, snapshot: snapshotApi });
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
