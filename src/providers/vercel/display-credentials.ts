import { randomBytes } from 'node:crypto';
import type { VercelBranchMetadataStore } from './metadata-store.js';
import type {
  VercelBranchMetadata,
  VercelBranchMetadataInput,
  VercelDisplayCredentials,
} from './metadata-schema.js';

export const DISPLAY_USERNAME = 'devbox' as const;

/**
 * Crockford-style alphabet with 0/O and 1/I/L removed, so a code read off a
 * screen and typed into the pairing form cannot be transcribed wrongly.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DISPLAY_CODE_LENGTH = 8;
export const DISPLAY_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

/**
 * A short pairing code, not a password.
 *
 * The display link carries this code and the proxy exchanges it for a cookie,
 * so it only has to survive being read aloud or typed once. 8 characters over a
 * 32-symbol alphabet is 40 bits, which at any plausible online guess rate is
 * out of reach, and the alphabet keeps it unambiguous. A 43-character base64url
 * secret is unusable in the pairing form, which is what it is for.
 */
export function generateDisplayPassword(): string {
  // 32 divides 256, so masking to 5 bits stays uniform.
  const chars = Array.from(randomBytes(DISPLAY_CODE_LENGTH), (byte) => PAIRING_ALPHABET[byte & 31]).join('');
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
