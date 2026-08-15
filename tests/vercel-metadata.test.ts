import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { readFile, stat } from 'node:fs/promises';
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
        tags: { provider: 'vercel', repository: 'repo', branch: 'main', version: '0.1.2' },
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
  });

  it('never writes a token supplied on an untrusted metadata object', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const metadata = {
      teamId: 'team',
      projectId: 'project',
      token: 'secret-token',
    } as Parameters<typeof store.write>[0] & { token: string };

    await store.write(metadata);

    await expect(readFile(store.path, 'utf8')).resolves.not.toContain('secret-token');
  });

  it('rejects an existing metadata file with group or world access', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    const { chmod } = await import('node:fs/promises');
    await chmod(store.path, 0o644);

    await expect(store.write({ teamId: 'team-2', projectId: 'project-2' })).rejects.toThrow(/insecure.*metadata mode/i);
    await expect(store.read()).rejects.toThrow(/insecure.*metadata mode/i);
  });

  it('fails closed when stored metadata is malformed JSON', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await writeFile(store.path, '{not-json');

    await expect(store.read()).rejects.toThrow(/malformed.*metadata/i);
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

  it('removes a lock when owner metadata writing fails', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const ownerWriter = vi.fn().mockRejectedValue(new Error('owner write failed'));

    await expect(store.acquireLock({ ownerWriter })).rejects.toThrow(/owner write failed/i);
    await expect(access(store.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('times out while a live lock owner remains active', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    const lock = await store.acquireLock();
    const owner = JSON.parse(await readFile(store.lockPath, 'utf8')) as Record<string, unknown>;
    expect(owner).toMatchObject({ pid: process.pid });
    expect(typeof owner.id).toBe('string');
    expect(typeof owner.acquiredAt).toBe('number');

    await expect(store.acquireLock({ timeoutMs: 35, retryMs: 5 })).rejects.toThrow(/timed out.*metadata lock/i);
    await lock.release();
  });

  it('recovers a lock whose recorded owner is dead', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await writeFile(store.lockPath, JSON.stringify({
      pid: 12345,
      id: 'dead-owner',
      acquiredAt: Date.now(),
    }), { mode: 0o600 });

    const lock = await store.acquireLock({ isProcessAlive: () => false });
    await lock.release();
    await expect(access(store.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an old orphan lock with malformed owner metadata', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-metadata-'));
    const store = createVercelMetadataStore({ stateHome, repoKey: 'repo' });
    await store.write({ teamId: 'team', projectId: 'project' });
    await writeFile(store.lockPath, 'not-json', { mode: 0o600 });
    const old = new Date(Date.now() - 1_000);
    await utimes(store.lockPath, old, old);

    const lock = await store.acquireLock({ staleLockMs: 10 });
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
});
