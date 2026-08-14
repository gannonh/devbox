import { describe, expect, it, vi } from 'vitest';
import { createLocalProvider } from '../src/providers/local/provider.js';
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
});
