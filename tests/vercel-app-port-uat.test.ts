import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  bootClearingStaleIdentity,
  isAmbiguousSandboxRemoval,
  isStaleSandboxIdentityConflict,
  removeEachMatchingLeftover,
} from '../scripts/vercel/app-port-uat-identity.mjs';

const RELEASE_34_STDERR = [
  'Create this Vercel sandbox? [y/N] ',
  '[devbox] The Vercel sandbox identity conflicts with this repository or branch; ',
  'remove the stale box with devbox --provider vercel main --rm and retry.\n',
].join('');

const RELEASE_35_STDERR = [
  '[devbox] Multiple live Vercel sandboxes match this repository and branch; ',
  'do not run automatic removal. Resolve the duplicate in the Vercel console ',
  'or manually identify and remove only the exact resource, then retry.\n',
].join('');

describe('app-route UAT stale sandbox identity recovery', () => {
  it('detects the mapped identity-conflict message from Release #34', () => {
    expect(isStaleSandboxIdentityConflict(RELEASE_34_STDERR)).toBe(true);
    expect(isStaleSandboxIdentityConflict(
      'Vercel team/project confirmation is required in a TTY; rerun interactively',
    )).toBe(false);
    expect(isStaleSandboxIdentityConflict(
      'UAT did not use the pinned monorepo revision',
    )).toBe(false);
    expect(isStaleSandboxIdentityConflict('')).toBe(false);
  });

  it('detects the mapped multi-match --rm abort from Release #35', () => {
    expect(isAmbiguousSandboxRemoval(RELEASE_35_STDERR)).toBe(true);
    expect(isAmbiguousSandboxRemoval(RELEASE_34_STDERR)).toBe(false);
    expect(isAmbiguousSandboxRemoval(
      'Vercel team/project confirmation is required in a TTY; rerun interactively',
    )).toBe(false);
    expect(isAmbiguousSandboxRemoval('')).toBe(false);
  });

  it('preflight-removes then boots when no leftover identity exists', async () => {
    const calls: string[] = [];
    const result = await bootClearingStaleIdentity({
      remove: async () => {
        calls.push('remove');
        return { code: 0, stdout: '', stderr: 'No Vercel sandbox exists for main; nothing to remove.\n' };
      },
      boot: async () => {
        calls.push('boot');
        return { code: 0, stdout: '', stderr: 'Create this Vercel sandbox? [y/N] ready\n' };
      },
    });
    expect(calls).toEqual(['remove', 'boot']);
    expect(result).toMatchObject({ code: 0, retried: false, clearedDuplicates: false });
  });

  it('clears every same-identity leftover when preflight --rm aborts on duplicates', async () => {
    const calls: string[] = [];
    const result = await bootClearingStaleIdentity({
      remove: async () => {
        calls.push('remove');
        return { code: 2, stdout: '', stderr: RELEASE_35_STDERR };
      },
      removeMatching: async () => {
        calls.push('remove-matching');
      },
      boot: async () => {
        calls.push('boot');
        return { code: 0, stdout: '', stderr: 'Create this Vercel sandbox? [y/N] ready\n' };
      },
    });
    expect(calls).toEqual(['remove', 'remove-matching', 'boot']);
    expect(result).toMatchObject({ code: 0, retried: false, clearedDuplicates: true });
  });

  it('removes a conflicting leftover identity and retries boot once', async () => {
    const calls: string[] = [];
    const attempts: number[] = [];
    const result = await bootClearingStaleIdentity({
      remove: async () => {
        calls.push('remove');
        return { code: 0, stdout: '', stderr: 'Vercel sandbox leftover: cleanup verified\n' };
      },
      boot: async ({ attempt }) => {
        attempts.push(attempt);
        calls.push(`boot-${attempt}`);
        if (attempt === 1) return { code: 2, stdout: '', stderr: RELEASE_34_STDERR };
        return { code: 0, stdout: '', stderr: 'ready\n' };
      },
    });
    expect(calls).toEqual(['remove', 'boot-1', 'remove', 'boot-2']);
    expect(attempts).toEqual([1, 2]);
    expect(result).toMatchObject({ code: 0, retried: true, clearedDuplicates: false });
  });

  it('does not retry a confirmation refusal or other non-identity failure', async () => {
    const calls: string[] = [];
    const result = await bootClearingStaleIdentity({
      remove: async () => {
        calls.push('remove');
        return { code: 0, stdout: '', stderr: 'nothing to remove.\n' };
      },
      removeMatching: async () => {
        calls.push('remove-matching');
      },
      boot: async () => {
        calls.push('boot');
        return {
          code: 2,
          stdout: '',
          stderr: '[devbox] Vercel team/project confirmation is required in a TTY\n',
        };
      },
    });
    expect(calls).toEqual(['remove', 'boot']);
    expect(result).toMatchObject({ code: 2, retried: false, clearedDuplicates: false });
  });

  it('fails closed when preflight --rm exits non-zero for a non-duplicate reason', async () => {
    const calls: string[] = [];
    await expect(bootClearingStaleIdentity({
      remove: async () => ({
        code: 2,
        stdout: '',
        stderr: '[devbox] Vercel cleanup is incomplete; retry --rm and inspect the retained recovery metadata.\n',
      }),
      removeMatching: async () => {
        calls.push('remove-matching');
      },
      boot: async () => {
        throw new Error('boot must not run after a failed preflight --rm');
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining('preflight-remove exited 2'),
      phase: 'preflight-remove',
    });
    expect(calls).toEqual([]);
  });

  it('fails closed on the Release #35 abort when no duplicate-clear callback is provided', async () => {
    await expect(bootClearingStaleIdentity({
      remove: async () => ({
        code: 2,
        stdout: '',
        stderr: RELEASE_35_STDERR,
      }),
      boot: async () => {
        throw new Error('boot must not run after a failed preflight --rm');
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining('preflight-remove exited 2'),
      phase: 'preflight-remove',
    });
  });
});

describe('app-route UAT multi-match leftover cleanup', () => {
  it('removes every same-identity leftover and leaves foreign-scope records untouched', async () => {
    const ownA = { name: 'devbox-v-0-1-11-uat-main-aaaa', identity: 'own' };
    const ownB = { name: 'devbox-v-0-1-12-uat-main-bbbb', identity: 'own' };
    const foreign = { name: 'devbox-other-scope-uat-main-cccc', identity: 'foreign' };
    let remaining = [ownA, ownB, foreign];
    const cleaned: string[] = [];

    const result = await removeEachMatchingLeftover({
      inspect: async () => ({
        matches: remaining.filter((record) => record.identity === 'own'),
        foreignScope: remaining.filter((record) => record.identity !== 'own').map((record) => record.name),
      }),
      cleanup: async (record: { name: string }) => {
        cleaned.push(record.name);
        remaining = remaining.filter((entry) => entry.name !== record.name);
        return { verified: true };
      },
    });

    expect(cleaned).toEqual([ownA.name, ownB.name]);
    expect(result).toEqual({
      removed: [ownA.name, ownB.name],
      foreignScope: [foreign.name],
    });
    expect(remaining).toEqual([foreign]);
  });

  it('retries a stale post-delete listing until the collection converges', async () => {
    const ownA = { name: 'devbox-v-0-1-11-uat-main-aaaa' };
    const ownB = { name: 'devbox-v-0-1-12-uat-main-bbbb' };
    const delays: number[] = [];
    let inspects = 0;
    const cleaned: string[] = [];

    const result = await removeEachMatchingLeftover({
      timeoutMs: 1_000,
      maxAttempts: 8,
      backoffMs: 250,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      inspect: async () => {
        inspects += 1;
        if (inspects <= 2) {
          return { matches: [ownA, ownB], foreignScope: [] };
        }
        return { matches: [], foreignScope: [] };
      },
      cleanup: async (record: { name: string }) => {
        cleaned.push(record.name);
        return { verified: true };
      },
    });

    expect(cleaned).toEqual([ownA.name, ownB.name]);
    expect(inspects).toBe(3);
    expect(delays).toEqual([250]);
    expect(result).toEqual({ removed: [ownA.name, ownB.name], foreignScope: [] });
  });

  it('fails closed when a matching leftover still exists after cleanup', async () => {
    let inspects = 0;
    await expect(removeEachMatchingLeftover({
      timeoutMs: 1_000,
      maxAttempts: 3,
      backoffMs: 250,
      sleep: async () => {},
      inspect: async () => {
        inspects += 1;
        return {
          matches: [{ name: 'leftover-a' }, { name: 'leftover-b' }],
          foreignScope: [],
        };
      },
      cleanup: async () => ({ verified: true }),
    })).rejects.toMatchObject({
      message: expect.stringContaining('matching-remove left 2 live sandbox(es)'),
      phase: 'matching-remove',
    });
    expect(inspects).toBe(4);
  });

  it('fails closed when cleanup does not verify a named leftover', async () => {
    await expect(removeEachMatchingLeftover({
      inspect: async () => ({
        matches: [{ name: 'leftover-a' }],
        foreignScope: [],
      }),
      cleanup: async () => ({ verified: false }),
    })).rejects.toMatchObject({
      message: 'matching-remove did not verify leftover-a',
      phase: 'matching-remove',
    });
  });
});

describe('app-route UAT wiring', () => {
  it('clears leftover identity in the UAT harness without weakening the CLI check', async () => {
    const uat = await readFile('scripts/vercel/app-port-uat.mjs', 'utf8');
    const helper = await readFile('scripts/vercel/app-port-uat-identity.mjs', 'utf8');
    const lifecycle = await readFile('src/providers/vercel/lifecycle.ts', 'utf8');
    const provider = await readFile('src/providers/vercel/provider.ts', 'utf8');
    const recovery = await readFile('src/providers/vercel/recovery.ts', 'utf8');
    const errors = await readFile('src/providers/vercel/errors.ts', 'utf8');

    expect(helper).toContain('dedicated non-interactive path');
    expect(helper).toContain('removeEachMatchingLeftover');
    expect(uat).toContain("from './app-port-uat-identity.mjs'");
    expect(uat).toContain('bootClearingStaleIdentity');
    expect(uat).toContain('removeMatching');
    expect(uat).toContain('listBranchIdentityMatches');
    expect(uat).toContain('cleanupVercelSandbox');
    expect(provider).not.toContain('bootClearingStaleIdentity');
    expect(provider).not.toContain('removeEachMatchingLeftover');
    expect(lifecycle).toContain('throw new VercelIdentityConflictError');
    expect(lifecycle).not.toContain('bootClearingStaleIdentity');
    expect(recovery).toContain('if (matches.length > 1)');
    expect(errors).toContain('do not run automatic removal');

    const monorepo = sliceFunction(uat, 'async function monorepoScenario', 'async function viteScenario');
    const vite = sliceFunction(uat, 'async function viteScenario', 'async function nextScenario');
    const next = sliceFunction(uat, 'async function nextScenario', 'async function bootScenario');
    for (const [label, source] of [['monorepo', monorepo], ['vite', vite], ['next', next]] as const) {
      const boot = source.indexOf('bootScenario');
      const cleanup = source.indexOf('rememberCleanup');
      expect(boot, `${label} must boot through stale-identity recovery`).toBeGreaterThan(-1);
      expect(cleanup, `${label} must register cleanup after boot`).toBeGreaterThan(boot);
    }

    const pin = monorepo.indexOf('metadata.appPorts.revision === MONOREPO_REVISION');
    const cleanup = monorepo.indexOf('rememberCleanup');
    expect(cleanup).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(cleanup);
  });
});

function sliceFunction(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}
