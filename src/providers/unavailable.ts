import { ProviderOperationError, type DevboxProvider, type DisplayCredentialsResult } from './types.js';

/** Explicit placeholder until the Vercel SDK/image phases are implemented. */
export function createUnavailableProvider(name: 'vercel'): DevboxProvider {
  const unavailable = (): never => {
    throw new ProviderOperationError(`${name} provider is not available in this release`, 2);
  };

  return {
    name,
    async up() {
      return unavailable();
    },
    async attach() {
      return unavailable();
    },
    async stop() {
      return unavailable();
    },
    async remove() {
      return unavailable();
    },
    async list() {
      return unavailable();
    },
    async url() {
      return unavailable();
    },
    async getDisplayCredentials(): Promise<DisplayCredentialsResult> {
      return unavailable();
    },
  };
}
