import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  bootClearingStaleIdentity,
  isStaleSandboxIdentityConflict,
} from '../scripts/vercel/app-port-uat-identity.mjs';

const RELEASE_34_STDERR = [
  'Create this Vercel sandbox? [y/N] ',
  '[devbox] The Vercel sandbox identity conflicts with this repository or branch; ',
  'remove the stale box with devbox --provider vercel main --rm and retry.\n',
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
    expect(result).toMatchObject({ code: 0, retried: false });
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
    expect(result).toMatchObject({ code: 0, retried: true });
  });

  it('does not retry a confirmation refusal or other non-identity failure', async () => {
    const calls: string[] = [];
    const result = await bootClearingStaleIdentity({
      remove: async () => {
        calls.push('remove');
        return { code: 0, stdout: '', stderr: 'nothing to remove.\n' };
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
    expect(result).toMatchObject({ code: 2, retried: false });
  });

  it('fails closed when preflight --rm itself exits non-zero', async () => {
    await expect(bootClearingStaleIdentity({
      remove: async () => ({
        code: 2,
        stdout: '',
        stderr: '[devbox] Multiple live Vercel sandboxes match this repository and branch\n',
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

describe('app-route UAT wiring', () => {
  it('clears leftover identity in the UAT harness without weakening the CLI check', async () => {
    const uat = await readFile('scripts/vercel/app-port-uat.mjs', 'utf8');
    const helper = await readFile('scripts/vercel/app-port-uat-identity.mjs', 'utf8');
    const lifecycle = await readFile('src/providers/vercel/lifecycle.ts', 'utf8');
    const provider = await readFile('src/providers/vercel/provider.ts', 'utf8');

    expect(helper).toContain('dedicated non-interactive path');
    expect(uat).toContain("from './app-port-uat-identity.mjs'");
    expect(uat).toContain('bootClearingStaleIdentity');
    expect(provider).not.toContain('bootClearingStaleIdentity');
    expect(lifecycle).toContain('throw new VercelIdentityConflictError');
    expect(lifecycle).not.toContain('bootClearingStaleIdentity');

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
