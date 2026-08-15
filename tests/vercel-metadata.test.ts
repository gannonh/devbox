import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
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
});
