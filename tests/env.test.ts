import { describe, it, expect, vi } from 'vitest';
import { resolveDevboxEnv, resolveGhToken } from '../src/lib/env.js';
import type { ShellRunner } from '../src/lib/shell.js';

function mockShell(impl: Partial<ShellRunner>): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
    ...impl,
  } as ShellRunner;
}

describe('resolveDevboxEnv', () => {
  it('returns explicit DEVBOX_ENV when set', () => {
    const result = resolveDevboxEnv('/repo', { DEVBOX_ENV: '/custom/.env' });
    expect(result).toBe('/custom/.env');
  });

  it('defaults to $HOME/dotfiles/repos/<repoName>/.env', () => {
    const result = resolveDevboxEnv('/Volumes/EVO/dev/my-repo', {}, '/home/user');
    expect(result).toBe('/home/user/dotfiles/repos/my-repo/.env');
  });
});

describe('resolveGhToken', () => {
  it('returns explicit GH_TOKEN when set', async () => {
    const token = await resolveGhToken({ GH_TOKEN: 'explicit-token' }, mockShell({}), () => true);
    expect(token).toBe('explicit-token');
  });

  it('falls back to GITHUB_TOKEN when GH_TOKEN not set', async () => {
    const token = await resolveGhToken({ GITHUB_TOKEN: 'gh-token' }, mockShell({}), () => false);
    expect(token).toBe('gh-token');
  });

  it('queries gh auth token when no env var is set', async () => {
    const exec = vi.fn().mockResolvedValue('ghp_12345');
    const runner = mockShell({ exec });
    const token = await resolveGhToken({}, runner, () => true);
    expect(token).toBe('ghp_12345');
    expect(exec).toHaveBeenCalledWith('gh', ['auth', 'token'], { silentStderr: true });
  });

  it('returns empty string when gh is not available and no env vars', async () => {
    const token = await resolveGhToken({}, mockShell({}), () => false);
    expect(token).toBe('');
  });

  it('returns empty string when gh auth token fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('not authed'));
    const runner = mockShell({ exec });
    const token = await resolveGhToken({}, runner, () => true);
    expect(token).toBe('');
  });
});
