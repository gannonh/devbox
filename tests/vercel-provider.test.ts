import { describe, expect, it } from 'vitest';
import { defaultProviderRegistry, resolveProvider } from '../src/providers/registry.js';
import type { ProviderBranchRequest } from '../src/providers/types.js';
import { PassThrough } from 'node:stream';

const request: ProviderBranchRequest = {
  repoRoot: '/repo',
  repoName: 'repo',
  env: {},
  tty: false,
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  branch: 'feature',
};

describe('vercel provider placeholder', () => {
  it('routes explicitly but reports that Vercel is not available yet', async () => {
    const provider = resolveProvider('vercel', defaultProviderRegistry);

    await expect(provider.up(request)).rejects.toThrow(/vercel provider is not available/i);
  });
});
