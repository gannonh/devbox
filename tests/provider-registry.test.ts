import { describe, expect, it } from 'vitest';
import {
  createProviderRegistry,
  resolveProvider,
  type ProviderRegistry,
} from '../src/providers/registry.js';
import type {
  DevboxProvider,
  ProviderActionResult,
} from '../src/providers/types.js';

function stubProvider(name: 'local' | 'vercel'): DevboxProvider {
  const action = async (): Promise<ProviderActionResult> => ({ exitCode: 0 });
  return {
    name,
    up: async () => action(),
    attach: async () => action(),
    stop: async () => action(),
    remove: async () => action(),
    list: async () => action(),
    url: async () => action(),
  };
}

describe('provider registry', () => {
  it('registers the production Vercel provider without resolving credentials at import time', () => {
    expect(resolveProvider('vercel', undefined).name).toBe('vercel');
  });

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
