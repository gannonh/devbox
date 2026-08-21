import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafeEnvironmentKeys, readEnvironmentFile, resolveGhToken } from '../src/providers/local/env.js';
import type { ShellRunner } from '../src/lib/shell.js';

function mockShell(impl: Partial<ShellRunner>): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
    ...impl,
  } as ShellRunner;
}

describe('readEnvironmentFile', () => {
  it('parses dotenv values without returning comments or export syntax', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-env-'));
    const path = join(root, '.env');
    await writeFile(path, '# comment\nexport API_KEY="secret-value"\nPORT=5173\n');

    try {
      await expect(readEnvironmentFile(path)).resolves.toEqual({ API_KEY: 'secret-value', PORT: '5173' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a missing selected file without exposing values', async () => {
    const path = join(tmpdir(), 'devbox-env-missing', '.env');
    await expect(readEnvironmentFile(path)).rejects.toThrow(`unable to read env file ${path}`);
  });

  it('rejects keys that are not shell identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devbox-env-key-'));
    for (const line of ['A B=1', 'FOO$(whoami)=x', '1BAD=1', 'BAD-NAME=1']) {
      const path = join(root, '.env');
      await writeFile(path, `${line}\n`);
      try {
        await expect(readEnvironmentFile(path)).rejects.toThrow('invalid variable name');
      } finally {
        await rm(path, { force: true });
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('rejects reserved shell-startup keys', () => {
    for (const key of ['BASH_ENV', 'ENV', 'PROMPT_COMMAND']) {
      expect(() => assertSafeEnvironmentKeys({ [key]: 'dummy' })).toThrow('invalid variable name');
    }
    expect(() => assertSafeEnvironmentKeys({ OK_KEY: 'dummy' })).not.toThrow();
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
