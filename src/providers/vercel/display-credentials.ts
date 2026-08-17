import { randomBytes } from 'node:crypto';
import type { VercelBranchMetadataStore } from './metadata-store.js';
import type {
  VercelBranchMetadata,
  VercelBranchMetadataInput,
  VercelDisplayCredentials,
} from './metadata-schema.js';

export const DISPLAY_USERNAME = 'devbox' as const;
export const DISPLAY_PASSWORD_BYTES = 32;
export const DISPLAY_PASSWORD_ENCODING = 'base64url' as const;

export function generateDisplayPassword(): string {
  return randomBytes(DISPLAY_PASSWORD_BYTES).toString(DISPLAY_PASSWORD_ENCODING);
}

export interface DisplayCredentialsResolution {
  credentials: VercelDisplayCredentials;
  generated: boolean;
}

export class DisplayCredentialsNotFoundError extends Error {
  readonly code = 'display_credentials_not_found';

  constructor() {
    super('Vercel branch metadata was not found');
    this.name = 'DisplayCredentialsNotFoundError';
  }
}

export async function getDisplayCredentials(
  store: VercelBranchMetadataStore,
): Promise<DisplayCredentialsResolution> {
  const metadata = await store.read();
  if (!metadata) throw new DisplayCredentialsNotFoundError();
  if (metadata.displayCredentials) return { credentials: metadata.displayCredentials, generated: false };

  return store.withLock(async () => {
    const current = await store.read();
    if (!current) throw new DisplayCredentialsNotFoundError();
    if (current.displayCredentials) {
      return { credentials: current.displayCredentials, generated: false };
    }
    const credentials: VercelDisplayCredentials = {
      username: DISPLAY_USERNAME,
      password: generateDisplayPassword(),
    };
    await store.write({ ...toBranchMetadataInput(current), displayCredentials: credentials });
    return { credentials, generated: true };
  });
}

function toBranchMetadataInput(metadata: VercelBranchMetadata): VercelBranchMetadataInput {
  return {
    identity: metadata.identity,
    sandboxId: metadata.sandboxId,
    snapshotIds: metadata.snapshotIds,
    residual: metadata.residual,
    configuration: metadata.configuration,
  };
}
