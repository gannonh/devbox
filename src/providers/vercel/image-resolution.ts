import { readFileSync } from 'node:fs';
import type { VercelCredentials } from './auth.js';
import {
  assertValidVercelImagePin,
  parseVercelImageReference,
  type VercelImagePin,
} from './image.js';

/**
 * Resolve which Sandbox image to boot.
 *
 * The rule is: tags for development, digests for releases. Nothing in the
 * source tree carries a digest, so a commit's code and its image always come
 * from the same commit. A published package carries a frozen pin emitted at
 * publish time; a git checkout resolves a channel tag instead.
 */

/** The channel a git checkout follows when no release pin is present. */
export const VERCEL_IMAGE_CHANNEL = 'nightly';

/** Repository the channel tag is resolved against. */
export const VERCEL_IMAGE_REPOSITORY = 'vcr.vercel.com/astro-labs/devbox/devbox';

/** Emitted into the package at publish time; absent in a git checkout. */
const RELEASE_PIN_URL = new URL('../../vercel-image-pin.json', import.meta.url);

export type VercelImageSource = 'override' | 'release-pin' | 'channel';

export interface VercelImageResolution {
  /** Fully-qualified `<host>/<team>/<project>/<repository>@sha256:<digest>`. */
  reference: string;
  source: VercelImageSource;
}

/**
 * Resolves a channel tag to a manifest digest. Injected so the transport stays
 * out of the precedence logic and so tests never reach the network.
 */
export type VercelImageChannelResolver = (
  channel: string,
  credentials: VercelCredentials,
  signal?: AbortSignal,
) => Promise<string>;

export interface VercelImageResolutionOptions {
  env: NodeJS.ProcessEnv;
  credentials: VercelCredentials;
  resolveChannel: VercelImageChannelResolver;
  /** Overridable for tests; defaults to the emitted package pin. */
  releasePinUrl?: URL;
  signal?: AbortSignal;
}

export class VercelImageResolutionError extends Error {
  readonly code = 'image_resolution_failed';

  constructor(message: string) {
    super(message);
    this.name = 'VercelImageResolutionError';
  }
}

/**
 * Read the frozen pin emitted into a published package. Returns undefined in a
 * git checkout, where no pin file is emitted.
 */
export function readReleasePin(pinUrl: URL = RELEASE_PIN_URL): VercelImagePin | undefined {
  let raw: string;
  try {
    raw = readFileSync(pinUrl, 'utf8');
  } catch {
    return undefined;
  }
  let pin: VercelImagePin;
  try {
    pin = JSON.parse(raw) as VercelImagePin;
  } catch {
    throw new VercelImageResolutionError('Vercel image pin is not valid JSON');
  }
  // A malformed pin in a published package must fail closed rather than fall
  // through to a floating channel tag.
  assertValidVercelImagePin(pin);
  return pin;
}

export async function resolveVercelImage(
  options: VercelImageResolutionOptions,
): Promise<VercelImageResolution> {
  const releasePin = readReleasePin(options.releasePinUrl);
  const override = options.env.DEVBOX_VERCEL_IMAGE?.trim();

  if (override) {
    // A published package ships a tested digest; letting an environment
    // variable redirect it would defeat the point of freezing one.
    if (releasePin) {
      throw new VercelImageResolutionError(
        'DEVBOX_VERCEL_IMAGE cannot override the image pinned in a published devbox release',
      );
    }
    parseVercelImageReference(override);
    return { reference: override, source: 'override' };
  }

  if (releasePin) return { reference: releasePin.reference, source: 'release-pin' };

  const channel = VERCEL_IMAGE_CHANNEL;
  const digest = await options.resolveChannel(channel, options.credentials, options.signal);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new VercelImageResolutionError(
      `Vercel image channel '${channel}' did not resolve to a manifest digest`,
    );
  }
  const reference = `${VERCEL_IMAGE_REPOSITORY}@${digest}`;
  parseVercelImageReference(reference);
  return { reference, source: 'channel' };
}
