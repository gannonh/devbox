import { describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVercelBranchMetadataStore,
  createVercelMetadataStore,
  createVercelScopeMetadataStore,
} from '../src/providers/vercel/metadata.js';

describe('Vercel metadata', () => {
  it('keeps repository scope and branch sandbox records in independent keyed stores', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-split-'));
    const scope = createVercelScopeMetadataStore({ stateHome, repoKey: 'github.com/acme/repo' });
    const feature = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/a',
    });
    const release = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'release',
    });

    await scope.write({ teamId: 'team', projectId: 'project' });
    await feature.write({ identity: {
      name: 'feature-sandbox',
      repository: 'github.com/acme/repo',
      branch: 'feature/a',
      packageVersion: '0.1.2',
      tags: {
        provider: 'vercel',
        repository: 'repo-tag',
        branch: 'feature-tag',
        version: 'version-tag',
        identity: 'feature-identity',
      },
    } });
    await release.write({ identity: {
      name: 'release-sandbox',
      repository: 'github.com/acme/repo',
      branch: 'release',
      packageVersion: '0.1.2',
      tags: {
        provider: 'vercel',
        repository: 'repo-tag',
        branch: 'release-tag',
        version: 'version-tag',
        identity: 'release-identity',
      },
    } });

    expect(feature.path).not.toBe(release.path);
    await expect(scope.read()).resolves.toEqual(expect.objectContaining({ teamId: 'team', projectId: 'project' }));
    await expect(feature.read()).resolves.toMatchObject({ identity: { branch: 'feature/a' } });
    await expect(release.read()).resolves.toMatchObject({ identity: { branch: 'release' } });
    expect(await readFile(feature.path, 'utf8')).not.toContain('teamId');
    expect(await readFile(feature.path, 'utf8')).not.toContain('projectId');
  });

  it('stores non-secret create configuration for idempotent validation', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });

    await store.write({
      teamId: 'team',
      projectId: 'project',
      configuration: {
        imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/new',
        needsBranchSetup: true,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });

    await expect(store.read()).resolves.toMatchObject({
      configuration: {
        imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
        sourceRevision: 'main',
        requestedBranch: 'feature/new',
        needsBranchSetup: true,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 1_800_000,
      },
    });
  });

  it('round-trips optional vcpus in branch create configuration', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-vcpus-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/new',
    });
    const baseConfiguration = {
      imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
      sourceUrl: 'https://github.com/acme/repo.git',
      sourceRevision: 'main',
      requestedBranch: 'feature/new',
      needsBranchSetup: true,
      persistent: true,
      keepLastSnapshots: 1,
      timeoutMs: 3_600_000,
    };

    await store.write({ configuration: { ...baseConfiguration, vcpus: 4 } });
    await expect(store.read()).resolves.toMatchObject({ configuration: { vcpus: 4 } });

    await store.write({ configuration: { ...baseConfiguration } });
    const stored = (await store.read())!.configuration!;
    expect('vcpus' in stored).toBe(false);
  });

  it('round-trips retained snapshot metadata without policy fields', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-pause-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/new',
    });

    await store.write({
      pausedSnapshot: {
        id: 'snapshot-1',
        sourceSessionId: 'session-1',
        createdAt: 1_700_000_000_000,
      },
    });

    await expect(store.read()).resolves.toMatchObject({
      pausedSnapshot: {
        id: 'snapshot-1',
        sourceSessionId: 'session-1',
        createdAt: 1_700_000_000_000,
      },
    });
  });

  it('rejects removed session policy metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-removed-policy-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/new',
    });

    await expect(store.write({ idlePauseMinutes: 15 } as never)).rejects.toThrow(/idlePauseMinutes/);
  });

  it.each([
    ['zero', 0],
    ['negative', -4],
    ['fractional', 2.5],
    ['odd', 3],
    ['over the cap', 33],
  ])('rejects %s vcpus in branch create configuration', async (_label, vcpus) => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-vcpus-invalid-'));
    const store = createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/new',
    });

    await expect(store.write({
      configuration: {
        imageReference: 'vcr.vercel.com/team/project/image@sha256:digest',
        sourceUrl: 'https://github.com/acme/repo.git',
        sourceRevision: 'main',
        requestedBranch: 'feature/new',
        needsBranchSetup: true,
        persistent: true,
        keepLastSnapshots: 1,
        timeoutMs: 3_600_000,
        vcpus,
      },
    })).rejects.toThrow(/vcpus must be 1 or an even integer up to 32/);
  });
  it('writes and reads non-secret scope metadata with mode 0600', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({
      stateHome,
      repoKey: 'https://github.com/acme/repo',
      provider: 'vercel',
    });

    await store.write({
      teamId: 'team',
      projectId: 'project',
      identity: {
        name: 'devbox-vercel-repo-main',
        repository: 'github.com/acme/repo',
        branch: 'main',
        packageVersion: '0.1.2',
        tags: {
          provider: 'vercel',
          repository: 'repo',
          branch: 'main',
          version: '0.1.2',
          identity: 'identity-tag',
        },
      },
      sandboxId: 'sandbox-id',
      snapshotIds: ['snapshot-id'],
      residual: { reason: 'none' },
    });

    await expect(store.read()).resolves.toMatchObject({
      teamId: 'team',
      projectId: 'project',
      identity: expect.objectContaining({ repository: 'github.com/acme/repo' }),
      sandboxId: 'sandbox-id',
      snapshotIds: ['snapshot-id'],
      residual: { reason: 'none' },
    });
    await expect(stat(store.path).then((value) => value.mode & 0o777)).resolves.toBe(0o600);
    const reopened = createVercelMetadataStore({
      stateHome,
      repoKey: 'https://github.com/acme/repo',
      provider: 'vercel',
    });
    await expect(reopened.read()).resolves.toMatchObject({ teamId: 'team', projectId: 'project' });
  });

  it('removes an existing metadata record through the public store API', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });

    await expect(store.remove()).resolves.toBeUndefined();
    await expect(access(store.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.read()).resolves.toBeNull();
  });

  it('treats removing a missing metadata record as an idempotent no-op', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });

    await expect(store.remove()).resolves.toBeUndefined();
    await expect(store.remove()).resolves.toBeUndefined();
  });

  it('rejects removing an insecure metadata record without deleting it', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await chmod(store.path, 0o644);

    await expect(store.remove()).rejects.toThrow(/insecure.*metadata mode/i);
    await expect(access(store.path)).resolves.toBeUndefined();
  });

  it('rejects removing a symlinked metadata record without deleting its target', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    const targetPath = `${store.path}.target`;
    await rename(store.path, targetPath);
    await symlink(targetPath, store.path);

    await expect(store.remove()).rejects.toThrow(/regular file|symbolic links|ELOOP/i);
    await expect(access(targetPath)).resolves.toBeUndefined();
    await expect(access(store.path)).resolves.toBeUndefined();

    await unlink(store.path);
    await rename(targetPath, store.path);
  });

  it('trims strings returned by the public metadata store schema', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({
      teamId: ' team ',
      projectId: ' project ',
      identity: {
        name: ' name ',
        repository: ' repository ',
        branch: ' branch ',
        packageVersion: ' version ',
        tags: {
          provider: ' provider ',
          repository: ' repository-tag ',
          branch: ' branch-tag ',
          version: ' version-tag ',
          identity: ' identity-tag ',
        },
      },
      sandboxId: ' sandbox ',
      snapshotIds: [' snapshot '],
      residual: {
        sandboxIds: [' residual-sandbox '],
        snapshotIds: [' residual-snapshot '],
        reason: ' reason ',
      },
    });

    await expect(store.read()).resolves.toMatchObject({
      teamId: 'team',
      projectId: 'project',
      identity: {
        name: 'name',
        repository: 'repository',
        branch: 'branch',
        packageVersion: 'version',
        tags: {
          provider: 'provider',
          repository: 'repository-tag',
          branch: 'branch-tag',
          version: 'version-tag',
          identity: 'identity-tag',
        },
      },
      sandboxId: 'sandbox',
      snapshotIds: ['snapshot'],
      residual: {
        sandboxIds: ['residual-sandbox'],
        snapshotIds: ['residual-snapshot'],
        reason: 'reason',
      },
    });
  });

  it('rejects a token-bearing write input instead of persisting it', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const metadata = {
      teamId: 'team',
      projectId: 'project',
      token: 'secret-token',
    } as Parameters<typeof store.write>[0] & { token: string };

    await expect(store.write(metadata)).rejects.toThrow(/unknown.*token/i);
  });

  it('rejects an existing metadata file with group or world access', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await chmod(store.path, 0o400);
    await expect(store.read()).rejects.toThrow(/expected 0600/i);
    await chmod(store.path, 0o644);

    await expect(store.write({ teamId: 'team-2', projectId: 'project-2' })).rejects.toThrow(/insecure.*metadata mode/i);
    await expect(store.read()).rejects.toThrow(/insecure.*metadata mode/i);
  });

  it('rejects an insecure application/provider directory', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await chmod(join(store.path, '..'), 0o755);

    await expect(store.read()).rejects.toThrow(/insecure metadata directory mode/i);
    await expect(store.write({ teamId: 'team', projectId: 'project' })).rejects.toThrow(/insecure metadata directory mode/i);
  });

  it('fails closed when stored metadata is malformed JSON', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await writeFile(store.path, '{not-json');

    await expect(store.read()).rejects.toThrow(/malformed.*metadata/i);
  });

  it('rejects a symlinked metadata record on read and write', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    const realPath = `${store.path}.real`;
    await rename(store.path, realPath);
    await symlink(realPath, store.path);

    await expect(store.read()).rejects.toThrow(/regular file|symbolic links|ELOOP/i);
    await expect(store.write({ teamId: 'team', projectId: 'project' })).rejects.toThrow(/regular file|symbolic links|ELOOP/i);

    await unlink(store.path);
    await rename(realPath, store.path);
  });

  it('rejects unknown and token-bearing top-level metadata fields', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    const stored = (await store.read())!;

    for (const field of ['token', 'refreshToken', 'password']) {
      await writeFile(store.path, JSON.stringify({ ...stored, [field]: 'secret-value' }));
      await expect(store.read()).rejects.toThrow(new RegExp(`unknown.*${field}`, 'i'));
    }
  });

  it('rejects metadata stored for another provider or repository key', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    const stored = (await store.read())!;

    await writeFile(store.path, JSON.stringify({ ...stored, provider: 'other' }));
    await expect(store.read()).rejects.toThrow(/provider mismatch/i);

    await writeFile(store.path, JSON.stringify({ ...stored, repoKeyHash: 'wrong' }));
    await expect(store.read()).rejects.toThrow(/repo key mismatch/i);
  });

  it('rejects identity tag secrets and unknown nested fields on write and read', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const identity = {
      name: 'name',
      repository: 'github.com/acme/repo',
      branch: 'main',
      packageVersion: '0.1.2',
      tags: {
        provider: 'vercel',
        repository: 'repo',
        branch: 'main',
        version: '0.1.2',
        identity: 'identity',
      },
    };
    const writeInput = {
      teamId: 'team',
      projectId: 'project',
      identity: { ...identity, tags: { ...identity.tags, token: 'secret' } },
    };

    await expect(store.write(writeInput as never)).rejects.toThrow(/unknown.*token/i);
    await store.write({ teamId: 'team', projectId: 'project', identity });
    const stored = (await store.read())!;
    await writeFile(store.path, JSON.stringify({
      ...stored,
      identity: {
        ...stored.identity,
        refreshToken: 'secret',
        tags: { ...stored.identity!.tags, password: 'secret' },
      },
    }));

    await expect(store.read()).rejects.toThrow(/unknown.*refreshToken/i);
  });

  it('serializes concurrent operations behind a local exclusive lock', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const firstLock = await store.acquireLock();
    let entered = false;
    const waiting = store.withLock(async () => {
      entered = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(entered).toBe(false);
    await firstLock.release();
    await waiting;
    expect(entered).toBe(true);
  });

  it('releases the lock when withLock operation throws', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });

    await expect(store.withLock(async () => {
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');

    const nextOwner = await store.acquireLock({ timeoutMs: 100 });
    await nextOwner.release();
  });

  it('rejects residual secrets and unknown nested fields on write and read', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const writeInput = {
      teamId: 'team',
      projectId: 'project',
      residual: { token: 'secret' },
    };

    await expect(store.write(writeInput as never)).rejects.toThrow(/unknown.*token/i);
    await store.write({ teamId: 'team', projectId: 'project', residual: { reason: 'retry' } });
    const stored = (await store.read())!;
    await writeFile(store.path, JSON.stringify({
      ...stored,
      residual: { ...stored.residual, refreshToken: 'secret' },
    }));

    await expect(store.read()).rejects.toThrow(/unknown.*refreshToken/i);
  });

  it('requires the exact identity tag set and non-empty nested values', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const identity = {
      name: 'name',
      repository: 'repo',
      branch: 'main',
      packageVersion: '0.1.2',
      tags: {
        provider: 'vercel',
        repository: 'repo',
        branch: 'main',
        version: '0.1.2',
        identity: 'identity',
      },
    };

    await expect(store.write({
      teamId: 'team',
      projectId: 'project',
      identity: { ...identity, tags: { ...identity.tags, identity: undefined } },
    } as never)).rejects.toThrow(/identity\.tags\.identity.*non-empty/i);
    await expect(store.write({
      teamId: 'team',
      projectId: 'project',
      identity: { ...identity, tags: { provider: 'vercel' } },
    } as never)).rejects.toThrow(/missing.*identity\.tags/i);
    await expect(store.write({
      teamId: 'team',
      projectId: 'project',
      identity: { ...identity, tags: { ...identity.tags, extra: 'value' } },
    } as never)).rejects.toThrow(/unknown.*extra/i);
  });

  it('times out while a live lock owner remains active', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const lock = await store.acquireLock();

    await expect(store.acquireLock({ timeoutMs: 35, retryMs: 5 })).rejects.toThrow(/timed out.*metadata lock/i);
    await lock.release();
  });

  it('recovers an old orphan lock directory through the lease protocol', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await mkdir(store.lockPath);
    const old = new Date(Date.now() - 3_000);
    await utimes(store.lockPath, old, old);

    const lock = await store.acquireLock({ staleLockMs: 2_000 });
    await lock.release();
    await expect(access(store.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('makes lock release idempotent and permits the next owner', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const first = await store.acquireLock();

    await first.release();
    await first.release();
    const second = await store.acquireLock();
    await second.release();
  });

  it('surfaces a compromised proper-lockfile lease', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    const onCompromised = vi.fn();
    const lock = await store.acquireLock({ staleLockMs: 2_000, onCompromised });
    await rm(store.lockPath, { recursive: true, force: true });

    await vi.waitFor(() => expect(onCompromised).toHaveBeenCalledOnce(), {
      timeout: 5_000,
      interval: 100,
    });
    expect(onCompromised.mock.calls[0][0]).toMatchObject({ code: 'ECOMPROMISED' });
    await expect(lock.release()).rejects.toBeInstanceOf(Error);
  });
});

describe('Vercel app port metadata', () => {
  const FINGERPRINT = 'a'.repeat(64);
  const REVISION = 'b'.repeat(40);
  const SANDBOX_ID = 'sbx_test';
  const RELAYS = [{ logicalPort: 5173, relayPort: 43111, label: 'vite' }];

  async function store() {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-app-ports-'));
    return createVercelBranchMetadataStore({
      stateHome,
      repoKey: 'github.com/acme/repo',
      branch: 'feature/ui',
    });
  }

  it('round-trips a committed selection with its relay mappings and applied set', async () => {
    const branch = await store();
    const appPorts = {
      sandboxId: SANDBOX_ID,
      selected: [5173],
      relays: RELAYS,
      applied: [6080, 43111],
      fingerprint: FINGERPRINT,
      detectorVersion: 1,
      revision: REVISION,
    };

    await branch.write({ appPorts });

    expect((await branch.read())?.appPorts).toEqual(appPorts);
  });

  it('round-trips a pending record with complete previous and desired states', async () => {
    const branch = await store();
    const pendingAppPorts = {
      sandboxId: SANDBOX_ID,
      previous: { relays: [], applied: [6080] },
      desired: { relays: RELAYS, applied: [6080, 43111] },
      selected: [5173],
      fingerprint: FINGERPRINT,
      detectorVersion: 1,
      revision: REVISION,
    };

    await branch.write({ pendingAppPorts });

    expect((await branch.read())?.pendingAppPorts).toEqual(pendingAppPorts);
  });

  it('stores an empty accepted set for a rejected candidate list', async () => {
    const branch = await store();

    await branch.write({
      appPorts: {
        sandboxId: SANDBOX_ID,
        selected: [],
        relays: [],
        applied: [6080],
        fingerprint: FINGERPRINT,
        detectorVersion: 1,
        revision: REVISION,
      },
    });

    expect((await branch.read())?.appPorts?.selected).toEqual([]);
  });

  it.each([
    ['a non-integer port', { selected: [5173.5] }, /integer port in 1\.\.65535/],
    ['an out-of-range port', { selected: [70000] }, /integer port in 1\.\.65535/],
    ['a duplicate port', { selected: [5173, 5173] }, /duplicates port 5173/],
    ['a non-array selection', { selected: 5173 }, /must be an array/],
    [
      'a relay mapping that reuses one logical port',
      {
        relays: [
          { logicalPort: 5173, relayPort: 43111, label: 'vite' },
          { logicalPort: 5173, relayPort: 43112, label: 'vite' },
        ],
      },
      /duplicates logical port 5173/,
    ],
    [
      'a relay mapping that reuses one listener port',
      {
        relays: [
          { logicalPort: 5173, relayPort: 43111, label: 'vite' },
          { logicalPort: 3000, relayPort: 43111, label: 'next' },
        ],
      },
      /duplicates relay port 43111/,
    ],
    [
      'a relay label carrying script text',
      { relays: [{ logicalPort: 5173, relayPort: 43111, label: 'vite --port 5173' }] },
      /printable label characters/,
    ],
    [
      'a relay mapping missing its listener port',
      { relays: [{ logicalPort: 5173, label: 'vite' }] },
      /Missing Metadata appPorts\.relays\[0\] field\(s\): relayPort/,
    ],
  ])('rejects %s', async (_label, overrides, message) => {
    const branch = await store();

    await expect(branch.write({
      appPorts: {
        sandboxId: SANDBOX_ID,
        selected: [5173],
        relays: RELAYS,
        applied: [6080, 43111],
        fingerprint: FINGERPRINT,
        detectorVersion: 1,
        revision: REVISION,
        ...overrides,
      } as never,
    })).rejects.toThrow(message);
  });

  it('rejects a selection that does not name the Sandbox it describes', async () => {
    const branch = await store();

    await expect(branch.write({
      appPorts: {
        selected: [5173],
        relays: RELAYS,
        applied: [6080, 43111],
        fingerprint: FINGERPRINT,
        detectorVersion: 1,
        revision: REVISION,
      } as never,
    })).rejects.toThrow(/Missing Vercel app port selection field\(s\): sandboxId/);
  });

  it('rejects a fingerprint that is not a SHA-256 digest', async () => {
    const branch = await store();

    await expect(branch.write({
      appPorts: {
        sandboxId: SANDBOX_ID,
        selected: [5173],
        relays: RELAYS,
        applied: [6080, 43111],
        fingerprint: 'not-a-digest',
        detectorVersion: 1,
        revision: REVISION,
      },
    })).rejects.toThrow(/SHA-256 hex digest/);
  });

  it('rejects a revision that is not a full commit SHA', async () => {
    const branch = await store();

    await expect(branch.write({
      appPorts: {
        sandboxId: SANDBOX_ID,
        selected: [5173],
        relays: RELAYS,
        applied: [6080, 43111],
        fingerprint: FINGERPRINT,
        detectorVersion: 1,
        revision: 'HEAD',
      },
    })).rejects.toThrow(/40-character commit SHA/);
  });

  it('rejects a non-positive detector version', async () => {
    const branch = await store();

    await expect(branch.write({
      appPorts: {
        sandboxId: SANDBOX_ID,
        selected: [5173],
        relays: RELAYS,
        applied: [6080, 43111],
        fingerprint: FINGERPRINT,
        detectorVersion: 0,
        revision: REVISION,
      },
    })).rejects.toThrow(/positive integer/);
  });

  it('rejects unknown app port fields', async () => {
    const branch = await store();

    await expect(branch.write({
      appPorts: {
        sandboxId: SANDBOX_ID,
        selected: [5173],
        relays: RELAYS,
        applied: [6080, 43111],
        fingerprint: FINGERPRINT,
        detectorVersion: 1,
        revision: REVISION,
        script: 'vite --port 5173',
      } as never,
    })).rejects.toThrow(/Unknown Vercel app port selection field\(s\): script/);
  });

  it('reads an obsolete raw-port record as absent instead of failing the document', async () => {
    const branch = await store();
    await branch.write({ sandboxId: 'sbx_test' });
    // Exactly what devbox 0.1.x committed before routes became relay-backed.
    const stored = JSON.parse(await readFile(branch.path, 'utf8')) as Record<string, unknown>;
    await writeFile(branch.path, `${JSON.stringify({
      ...stored,
      appPorts: {
        selected: [5173],
        applied: [5173, 6080],
        fingerprint: FINGERPRINT,
        detectorVersion: 1,
        revision: REVISION,
      },
    })}\n`, { mode: 0o600 });

    const metadata = await branch.read();

    // The identity beside it survives, so the box is still attachable; the
    // stale mapping is simply gone, which is the full-provisioning path.
    expect(metadata?.sandboxId).toBe('sbx_test');
    expect(metadata?.appPorts).toBeUndefined();
  });

  it('keeps the stored record free of any project text', async () => {
    const branch = await store();

    await branch.write({
      appPorts: {
        sandboxId: SANDBOX_ID,
        selected: [5173],
        relays: RELAYS,
        applied: [6080, 43111],
        fingerprint: FINGERPRINT,
        detectorVersion: 1,
        revision: REVISION,
      },
    });

    const raw = await readFile(branch.path, 'utf8');
    // The framework name is a closed vocabulary; a script, path, or dependency
    // string is what must never reach this file.
    expect(raw).not.toMatch(/--port|scripts|devDependencies|\.\//);
  });
});
