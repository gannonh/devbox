import { describe, expect, it, vi } from 'vitest';
import {
  cleanupVercelSandbox,
  type VercelCleanupAdapter,
} from '../src/providers/vercel/cleanup.js';

function credentials() {
  return { token: 'vercel-token', teamId: 'team', projectId: 'project' };
}

const identityTags = {
  provider: 'vercel',
  repository: 'repo',
  branch: 'main',
  version: 'v',
  identity: 'id',
};

describe('Vercel sandbox cleanup', () => {
  it('deletes a stale named sandbox without resuming it before snapshot proof', async () => {
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => { throw Object.assign(new Error('snapshot_not_found'), { status: 410 }); }),
      listSessions: vi.fn(async () => []),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'stale-sandbox',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(adapter.deleteByName).toHaveBeenCalledWith(expect.objectContaining({ name: 'stale-sandbox' }));
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('retains stale sandbox metadata when name deletion cannot be verified', async () => {
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => { throw Object.assign(new Error('snapshot_not_found'), { status: 410 }); }),
      listSessions: vi.fn(async () => []),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteByName: vi.fn(async () => { throw new Error('delete unavailable'); }),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'stale-delete-failure',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(result.residualSandboxIds).toEqual(['stale-delete-failure']);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(adapter.delete).not.toHaveBeenCalled();
    expect(result.errors.join(' ')).toContain('stale sandbox delete');
  });

  it('retains the requested sandbox name when the initial lookup fails', async () => {
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => { throw Object.assign(new Error('Vercel unavailable'), { status: 503 }); }),
      listSessions: vi.fn(async () => []),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'lookup-failure',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(result.residualSandboxIds).toEqual(['lookup-failure']);
    expect(result.errors.join(' ')).toContain('sandbox lookup');
    expect(adapter.listSessions).not.toHaveBeenCalled();
  });

  it('does not claim cleanup when an orphan snapshot appears after an empty missing-sandbox listing', async () => {
    let snapshotListCalls = 0;
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => { throw Object.assign(new Error('not found'), { notFound: true }); }),
      listSessions: vi.fn(async () => []),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => {
        snapshotListCalls += 1;
        return snapshotListCalls === 1
          ? []
          : [{ id: 'delayed-orphan', sourceSessionId: 'session', status: 'created' as const }];
      }),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'delayed-orphan',
        status: 'created' as const,
        delete: async () => {},
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'missing-delayed-orphan',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(snapshotListCalls).toBeGreaterThanOrEqual(2);
    expect(result.verified).toBe(false);
    expect(result.residualSnapshotIds).toEqual(['delayed-orphan']);
  });

  it('cleans matching snapshots even when the sandbox is already missing', async () => {
    let snapshots = [{ id: 'orphan-snapshot', sourceSessionId: 'session', status: 'created' as const }];
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => { throw Object.assign(new Error('not found'), { notFound: true }); }),
      listSessions: vi.fn(async () => []),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => snapshots),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'orphan-snapshot',
        status: 'created' as const,
        delete: async () => { snapshots = []; },
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'missing-sandbox',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 2,
      sleep: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(result.sandboxMissing).toBe(true);
    expect(adapter.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: 'orphan-snapshot' }));
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  it('fails closed when session enumeration cannot prove terminal state', async () => {
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => ({ name: 'enumeration-failure', status: 'running' as const, tags: identityTags })),
      listSessions: vi.fn(async () => { throw new Error('session API unavailable'); }),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'enumeration-failure',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(adapter.delete).not.toHaveBeenCalled();
    expect(result.errors.join(' ')).toContain('session listing');
  });

  it('stops failed sessions before deletion when they converge', async () => {
    let sessionReads = 0;
    let deleted = false;
    const sandbox = { name: 'failed-session-converges', status: 'stopped' as const, tags: identityTags };
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => sandbox),
      listSessions: vi.fn(async () => {
        sessionReads += 1;
        return [{ id: 'failed-session', status: sessionReads === 1 ? 'failed' as const : 'stopped' as const }];
      }),
      stop: vi.fn(async () => ({ id: 'failed-session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => { deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(adapter.delete).toHaveBeenCalledOnce();
    expect(deleted).toBe(true);
  });

  it('fails closed when a failed session cannot converge', async () => {
    const sandbox = { name: 'failed-session-stuck', status: 'stopped' as const, tags: identityTags };
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => sandbox),
      listSessions: vi.fn(async () => [{ id: 'failed-session', status: 'failed' as const }]),
      stop: vi.fn(async () => ({ id: 'failed-session', status: 'failed' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(adapter.delete).not.toHaveBeenCalled();
    expect(result.residualSandboxIds).toEqual([sandbox.name]);
    expect(result.errors.join(' ')).toContain('session verification');
  });

  it('reports non-deleted snapshots as residual cleanup instead of claiming success', async () => {
    let deleted = false;
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return { name: 'partial-sandbox', status: 'stopped' as const, tags: identityTags };
      }),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => [{ id: 'failed-snapshot', sourceSessionId: 'session', status: 'failed' as const }]),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'failed-snapshot',
        status: 'failed' as const,
        delete: async () => { throw new Error('snapshot delete rejected'); },
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => { deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: 'partial-sandbox',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 2,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(result.residualSnapshotIds).toEqual(['failed-snapshot']);
    expect(result.errors.join(' ')).toContain('snapshot delete failed-snapshot');
  });

  it('stops before deletion and verifies terminal sessions and snapshots', async () => {
    const calls: string[] = [];
    let sessionRead = 0;
    let snapshotRead = 0;
    let deleted = false;
    const sandbox = {
      name: 'devbox-sandbox',
      status: 'running' as const,
      tags: identityTags,
    };
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return sandbox;
      }),
      listSessions: vi.fn(async () => {
        sessionRead += 1;
        return [{ id: 'session-1', status: sessionRead === 1 ? 'running' as const : 'stopped' as const }];
      }),
      stop: vi.fn(async () => {
        calls.push('stop');
        return { id: 'session-1', status: 'stopped' as const };
      }),
      listSnapshots: vi.fn(async () => {
        snapshotRead += 1;
        return [{ id: 'snapshot-1', sourceSessionId: 'session-1', status: snapshotRead === 1 ? 'created' as const : 'deleted' as const }];
      }),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'snapshot-1',
        status: 'created' as const,
        delete: async () => { calls.push('snapshot-delete'); },
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => { calls.push('sandbox-delete'); deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 2,
      sleep: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(result.finalSessions).toEqual([{ id: 'session-1', status: 'stopped' }]);
    expect(result.snapshotIds).toEqual(['snapshot-1']);
    expect(calls).toEqual(['stop', 'sandbox-delete', 'snapshot-delete']);
  });

  it('does not treat an empty premature relist as proof that a known snapshot is absent', async () => {
    let deleted = false;
    let listCalls = 0;
    const sandbox = {
      name: 'premature-empty',
      status: 'stopped' as const,
      currentSnapshotId: 'snapshot-premature',
      tags: identityTags,
    };
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return sandbox;
      }),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => {
        listCalls += 1;
        if (listCalls === 3) {
          return [{ id: 'snapshot-premature', sourceSessionId: 'session', status: 'created' as const }];
        }
        return [];
      }),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'snapshot-premature',
        status: 'created' as const,
        delete: async () => {},
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => { deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 2,
      sleep: async () => {},
    });

    expect(listCalls).toBeGreaterThanOrEqual(3);
    expect(result.verified).toBe(false);
    expect(result.residualSnapshotIds).toEqual(['snapshot-premature']);
  });

  it('retries a delayed snapshot appearance before deleting and verifying it', async () => {
    let deleted = false;
    let listCalls = 0;
    let snapshotDeleted = false;
    const calls: string[] = [];
    const sandbox = {
      name: 'delayed-appearance',
      status: 'running' as const,
      tags: identityTags,
    };
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return sandbox;
      }),
      listSessions: vi.fn(async () => [{
        id: 'session',
        status: calls.includes('stop') ? 'stopped' as const : 'running' as const,
      }]),
      stop: vi.fn(async () => {
        calls.push('stop');
        return { id: 'session', status: 'stopped' as const, snapshot: { id: 'snapshot-delayed', status: 'created' as const } };
      }),
      listSnapshots: vi.fn(async () => {
        listCalls += 1;
        if (listCalls <= 2) return [];
        if (listCalls === 3) return [{ id: 'snapshot-delayed', sourceSessionId: 'session', status: 'created' as const }];
        return [{ id: 'snapshot-delayed', sourceSessionId: 'session', status: snapshotDeleted ? 'deleted' as const : 'created' as const }];
      }),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'snapshot-delayed',
        status: 'created' as const,
        delete: async () => { calls.push('snapshot-delete'); snapshotDeleted = true; },
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => { calls.push('sandbox-delete'); deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 5,
      sleep: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(result.snapshotIds).toEqual(['snapshot-delayed']);
    expect(result.residualSnapshotIds).toEqual([]);
    expect(calls).toEqual(['stop', 'sandbox-delete', 'snapshot-delete', 'snapshot-delete', 'snapshot-delete']);
  });

  it('retries delayed snapshot deletion and retains the ID until deleted is listed', async () => {
    let deleted = false;
    let listCalls = 0;
    let deleteCalls = 0;
    const sandbox = {
      name: 'delayed-deletion',
      status: 'stopped' as const,
      tags: identityTags,
    };
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return sandbox;
      }),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => {
        listCalls += 1;
        const status = listCalls >= 3 ? 'deleted' as const : 'created' as const;
        return [{ id: 'snapshot-delayed-delete', sourceSessionId: 'session', status }];
      }),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'snapshot-delayed-delete',
        status: 'created' as const,
        delete: async () => { deleteCalls += 1; },
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => { deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 4,
      sleep: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(deleteCalls).toBe(2);
    expect(result.residualSnapshotIds).toEqual([]);
  });

  it('fails closed and retains known snapshots when post-delete listing fails', async () => {
    let deleted = false;
    let listCalls = 0;
    const sandbox = {
      name: 'post-delete-list-failure',
      status: 'stopped' as const,
      tags: identityTags,
    };
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return sandbox;
      }),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => {
        listCalls += 1;
        if (listCalls === 2) throw new Error('snapshot list unavailable');
        return [{ id: 'snapshot-list-failure', sourceSessionId: 'session', status: 'created' as const }];
      }),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'snapshot-list-failure',
        status: 'created' as const,
        delete: async () => {},
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => { deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 2,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(result.residualSnapshotIds).toEqual(['snapshot-list-failure']);
    expect(result.errors.join(' ')).toContain('snapshot listing');
  });

  it('retains failed and created snapshot IDs after delete returns until relist proves resolution', async () => {
    let listCalls = 0;
    let deleteCalls = 0;
    const snapshots = [
      { id: 'snapshot-failed', sourceSessionId: 'session', status: 'failed' as const },
      { id: 'snapshot-created', sourceSessionId: 'session', status: 'created' as const },
    ];
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => { throw Object.assign(new Error('not found'), { notFound: true }); }),
      listSessions: vi.fn(async () => []),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => {
        listCalls += 1;
        return snapshots;
      }),
      getSnapshot: vi.fn(async ({ snapshotId }) => ({
        snapshotId,
        status: snapshotId === 'snapshot-failed' ? 'failed' as const : 'created' as const,
        delete: async () => { deleteCalls += 1; },
      })),
      deleteByName: vi.fn(async () => ({ missing: false })),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'missing-with-snapshots',
      credentials: credentials(),
      expectedTags: identityTags,
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(deleteCalls).toBeGreaterThanOrEqual(2);
    expect(result.verified).toBe(false);
    expect(result.residualSnapshotIds).toEqual(['snapshot-failed', 'snapshot-created']);
  });
});
