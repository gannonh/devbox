import { describe, expect, it } from 'vitest';
import {
  createProviderRegistry,
  resolveProvider,
  type DevboxProvider,
  type ProviderRegistry,
} from '../src/providers/registry.js';
import type { DisplayCredentialsResult, ProviderActionResult, ProviderBranchRequest, ProviderListRequest, ProviderUrlRequest } from '../src/providers/types.js';

function stubProvider(name: 'local' | 'vercel'): DevboxProvider {
  const action = async (): Promise<ProviderActionResult> => ({ exitCode: 0 });
  const credentials = async (): Promise<DisplayCredentialsResult> => ({
    supported: true,
    username: 'user',
    password: 'pass',
  });
  return {
    name,
    up: async (_request: ProviderBranchRequest) => action(),
    attach: async (_request: ProviderBranchRequest) => action(),
    stop: async (_request: ProviderBranchRequest) => action(),
    remove: async (_request: ProviderBranchRequest) => action(),
    list: async (_request: ProviderListRequest) => action(),
    url: async (_request: ProviderUrlRequest) => action(),
    getDisplayCredentials: async (_request: ProviderBranchRequest) => credentials(),
  };
}

describe('provider registry', () => {
  it('selects local by default and routes explicit provider names', () => {
    const local = stubProvider('local');
    const vercel = stubProvider('vercel');
    const registry: ProviderRegistry = createProviderRegistry({ local, vercel });

    expect(resolveProvider(undefined, registry)).toBe(local);
    expect(resolveProvider('local', registry)).toBe(local);
    expect(resolveProvider('vercel', registry)).toBe(vercel);
  });

  it('rejects unsupported provider names with a usage error', () => {
    const registry = createProviderRegistry({ local: stubProvider('local'), vercel: stubProvider('vercel') });

    expect(() => resolveProvider('fly' as never, registry)).toThrow(/unsupported provider.*fly/i);
  });
});
