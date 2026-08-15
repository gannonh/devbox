import { describe, expect, it, vi } from 'vitest';
import {
  cleanupVercelSandbox,
  type VercelCleanupAdapter,
} from '../src/providers/vercel/cleanup.js';

function credentials() {
  return { token: 'vercel-token', teamId: 'team', projectId: 'project' };
}

describe('Vercel sandbox cleanup', () => {
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
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'missing-sandbox',
      credentials: credentials(),
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
      get: vi.fn(async () => ({ name: 'enumeration-failure', status: 'running' as const })),
      listSessions: vi.fn(async () => { throw new Error('session API unavailable'); }),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => []),
      getSnapshot: vi.fn(),
      delete: vi.fn(async () => {}),
    };

    const result = await cleanupVercelSandbox({
      name: 'enumeration-failure',
      credentials: credentials(),
      adapter,
      maxAttempts: 1,
      sleep: async () => {},
    });

    expect(result.verified).toBe(false);
    expect(adapter.delete).not.toHaveBeenCalled();
    expect(result.errors.join(' ')).toContain('session listing');
  });

  it('reports non-deleted snapshots as residual cleanup instead of claiming success', async () => {
    let deleted = false;
    const adapter: VercelCleanupAdapter = {
      get: vi.fn(async () => {
        if (deleted) throw Object.assign(new Error('not found'), { notFound: true });
        return { name: 'partial-sandbox', status: 'stopped' as const };
      }),
      listSessions: vi.fn(async () => [{ id: 'session', status: 'stopped' as const }]),
      stop: vi.fn(async () => ({ id: 'session', status: 'stopped' as const })),
      listSnapshots: vi.fn(async () => [{ id: 'failed-snapshot', sourceSessionId: 'session', status: 'failed' as const }]),
      getSnapshot: vi.fn(async () => ({
        snapshotId: 'failed-snapshot',
        status: 'failed' as const,
        delete: async () => { throw new Error('snapshot delete rejected'); },
      })),
      delete: vi.fn(async () => { deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: 'partial-sandbox',
      credentials: credentials(),
      adapter,
      maxAttempts: 1,
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
      tags: { provider: 'vercel', repository: 'repo', branch: 'main', version: 'v', identity: 'id' },
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
      delete: vi.fn(async () => { calls.push('sandbox-delete'); deleted = true; }),
    };

    const result = await cleanupVercelSandbox({
      name: sandbox.name,
      credentials: credentials(),
      adapter,
      maxAttempts: 2,
      sleep: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(result.finalSessions).toEqual([{ id: 'session-1', status: 'stopped' }]);
    expect(result.snapshotIds).toEqual(['snapshot-1']);
    expect(calls).toEqual(['stop', 'snapshot-delete', 'sandbox-delete']);
  });
});
