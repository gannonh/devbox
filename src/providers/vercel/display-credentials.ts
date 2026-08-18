import { randomBytes } from 'node:crypto';
import type { VercelBranchMetadataStore } from './metadata-store.js';
import type {
  VercelBranchMetadata,
  VercelBranchMetadataInput,
  VercelDisplayCredentials,
} from './metadata-schema.js';

export const DISPLAY_USERNAME = 'devbox' as const;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateDisplayPassword(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => PAIRING_ALPHABET[byte & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
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
  if (metadata.displayCredentials) {
    return {
      credentials: metadata.displayCredentials,
      generated: metadata.displayCredentials.rotating === true,
    };
  }

  return store.withLock(async () => {
    const current = await store.read();
    if (!current) throw new DisplayCredentialsNotFoundError();
    if (current.displayCredentials) {
      return {
        credentials: current.displayCredentials,
        generated: current.displayCredentials.rotating === true,
      };
    }
    const credentials: VercelDisplayCredentials = {
      username: DISPLAY_USERNAME,
      password: generateDisplayPassword(),
      rotating: true,
    };
    await store.write({ ...toBranchMetadataInput(current), displayCredentials: credentials });
    return { credentials, generated: true };
  });
}

export async function clearDisplayCredentialRotation(
  store: VercelBranchMetadataStore,
  credentials: VercelDisplayCredentials,
): Promise<void> {
  await store.withLock(async () => {
    const current = await store.read();
    const currentCredentials = current?.displayCredentials;
    if (!current || !currentCredentials) throw new DisplayCredentialsNotFoundError();
    if (currentCredentials.password !== credentials.password) {
      throw new Error('Vercel display credentials changed during startup');
    }
    if (currentCredentials.rotating !== true) return;
    await store.write({
      ...toBranchMetadataInput(current),
      displayCredentials: {
        username: DISPLAY_USERNAME,
        password: credentials.password,
      },
    });
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
