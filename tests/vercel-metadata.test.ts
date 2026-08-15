import { describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVercelMetadataStore } from '../src/providers/vercel/metadata.js';

describe('Vercel metadata', () => {
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
