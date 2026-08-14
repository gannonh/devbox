import { describe, expect, it, vi } from 'vitest';
import { createLocalProvider } from '../src/providers/local/provider.js';
import { RealShellRunner } from '../src/lib/shell.js';
import type { ShellRunner } from '../src/lib/shell.js';
import type { ProviderBranchRequest } from '../src/providers/types.js';
import { PassThrough } from 'node:stream';

function mockRunner(): ShellRunner {
  return {
    exec: vi.fn(),
    execQuiet: vi.fn(),
    spawnInherit: vi.fn(),
  };
}

function request(branch = 'feature'): ProviderBranchRequest {
  return {
    repoRoot: '/repo',
    repoName: 'repo',
    env: {},
    tty: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    branch,
  };
}

describe('local provider', () => {
  it('reports display credentials as explicitly unsupported', async () => {
    const result = await createLocalProvider(mockRunner()).getDisplayCredentials(request());

    expect(result).toEqual({
      supported: false,
      message: expect.stringContaining('local provider'),
    });
  });

  it('returns a provider error when URL opening cannot spawn its executable', async () => {
    const realRunner = new RealShellRunner();
    const shell = mockRunner();
    shell.execQuiet = vi.fn(async (command, _args, options) => {
      if (command === 'docker') return { stdout: 'cid\n', code: 0 };
      return realRunner.execQuiet('/definitely/missing/devbox-open', [], options);
    });
    shell.exec = vi.fn().mockResolvedValue('/box');

    await expect(
      createLocalProvider(shell).url({ ...request(), open: true }),
    ).rejects.toMatchObject({ exitCode: 1, reported: true });
  });
});
