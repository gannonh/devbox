import { RealShellRunner } from '../lib/shell.js';
import { createLocalProvider } from './local/provider.js';
import { createUnavailableProvider } from './unavailable.js';
import type { DevboxProvider, ProviderName } from './types.js';
import { ProviderUsageError } from './types.js';

export interface ProviderRegistry {
  readonly local: DevboxProvider;
  readonly vercel: DevboxProvider;
}

/** Build a registry from the provider implementations available to a caller. */
export function createProviderRegistry(providers: ProviderRegistry): ProviderRegistry {
  return providers;
}

/** Registry used by the executable CLI. */
export const defaultProviderRegistry: ProviderRegistry = createProviderRegistry({
  local: createLocalProvider(new RealShellRunner()),
  vercel: createUnavailableProvider('vercel'),
});

/** Resolve a provider name, preserving local as the CLI default. */
export function resolveProvider(
  name: string | undefined,
  registry: ProviderRegistry,
): DevboxProvider {
  const selected = name ?? 'local';
  if (selected !== 'local' && selected !== 'vercel') {
    throw new ProviderUsageError(`unsupported provider: ${selected}`);
  }

  return registry[selected as ProviderName];
}

export const getProvider = resolveProvider;
