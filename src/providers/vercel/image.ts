/**
 * The promoted Vercel image contract.
 *
 * A release must consume a public, fully-qualified VCR reference pinned by
 * manifest digest.  The candidate workflow writes the smoke evidence into
 * this shape before it opens the promotion PR; release validation rejects
 * incomplete or untested pins.
 */

const VCR_HOST = 'vcr.vercel.com';
const SLUG = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?';
const DIGEST = 'sha256:[a-f0-9]{64}';
const FULL_REFERENCE = new RegExp(
  `^${VCR_HOST}/(${SLUG})/(${SLUG})/(${SLUG})@(${DIGEST})$`,
);
const UNIVERSAL_REFERENCE = new RegExp(
  `^${VCR_HOST}/vercel/sandbox/universal@(${DIGEST})$`,
);
const COMMIT = /^[a-f0-9]{40}$/;

export interface VercelImageReference {
  registry: typeof VCR_HOST;
  team: string;
  project: string;
  repository: string;
  digest: string;
}

export interface VercelImageScope {
  team: string;
  project: string;
}

export interface VercelImagePin {
  /** The only image reference consumed by the Vercel provider. */
  reference: string;
  /** Digest-pinned Universal image used as the custom image's base. */
  baseReference: string;
  /** The base manifest digest, repeated for review/searchability. */
  baseDigest: string;
  sourceCommit: string;
  publisherSmokeUrl: string;
  consumerSmokeUrl: string;
  publisher: VercelImageScope;
  consumer: VercelImageScope;
  /** The exact reference passed to both Sandbox smoke gates. */
  testedReference: string;
  publisherSmokeStatus?: 'passed' | 'failed' | 'pending';
  consumerSmokeStatus?: 'passed' | 'failed' | 'pending';
  crossProjectVerified?: boolean;
}

export interface VercelImagePinValidation {
  ok: boolean;
  reference?: VercelImageReference;
  baseReference?: VercelImageReference;
  errors: string[];
}

/**
 * Parse a fully-qualified VCR image reference.
 *
 * Tags, bare project-relative names, and references from another registry are
 * intentionally not accepted here.  The thrown error is useful to callers
 * that need a strict parser; use validateVercelImagePin for user-facing lists
 * of errors.
 */
export function parseVercelImageReference(value: string): VercelImageReference {
  const match = FULL_REFERENCE.exec(value);
  if (!match) {
    throw new Error(
      `Expected vcr.vercel.com/<team>/<project>/<repository>@sha256:<64 hex digits>, got ${value}`,
    );
  }

  return {
    registry: VCR_HOST,
    team: match[1],
    project: match[2],
    repository: match[3],
    digest: match[4],
  };
}

function parseUniversalReference(value: string): VercelImageReference {
  const match = UNIVERSAL_REFERENCE.exec(value);
  if (!match) {
    throw new Error(
      `Expected digest-pinned ${VCR_HOST}/vercel/sandbox/universal reference, got ${value}`,
    );
  }

  return {
    registry: VCR_HOST,
    team: 'vercel',
    project: 'sandbox',
    repository: 'universal',
    digest: match[1],
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isVercelSlug(value: string): boolean {
  return new RegExp(`^${SLUG}$`).test(value);
}

function isUninitializedDigest(value: string | undefined): boolean {
  return value === 'sha256:' + '0'.repeat(64);
}

/**
 * Validate the release-facing image pin and all evidence needed to promote it.
 * This is deliberately pure so package-quality checks and workflow scripts can
 * exercise the same rules without credentials or a live Vercel project.
 */
export function validateVercelImagePin(pin: VercelImagePin): VercelImagePinValidation {
  const errors: string[] = [];
  let reference: VercelImageReference | undefined;
  let baseReference: VercelImageReference | undefined;

  try {
    reference = parseVercelImageReference(pin.reference);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'image reference is malformed');
  }

  if (!pin.reference.includes('@sha256:')) {
    errors.push('image reference must be immutable and digest-pinned, not a floating tag');
  }
  if (isUninitializedDigest(reference?.digest)) {
    errors.push('image reference contains an uninitialized digest');
  }

  try {
    baseReference = parseUniversalReference(pin.baseReference);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'base image reference is malformed');
  }
  if (isUninitializedDigest(baseReference?.digest)) {
    errors.push('base image reference contains an uninitialized digest');
  }
  if (!baseReference || pin.baseDigest !== baseReference.digest) {
    errors.push('baseDigest must match the digest in baseReference');
  }

  if (!COMMIT.test(pin.sourceCommit)) {
    errors.push('sourceCommit must be a full 40-character hexadecimal commit SHA');
  } else if (/^0{40}$/.test(pin.sourceCommit)) {
    errors.push('sourceCommit is uninitialized');
  }

  if (!isHttpsUrl(pin.publisherSmokeUrl)) {
    errors.push('publisherSmokeUrl must be an HTTPS smoke evidence URL');
  }
  if (!isHttpsUrl(pin.consumerSmokeUrl)) {
    errors.push('consumerSmokeUrl must be an HTTPS smoke evidence URL');
  }
  if (pin.publisherSmokeUrl === pin.consumerSmokeUrl) {
    errors.push('publisher and consumer smoke evidence must be independent URLs');
  }

  if (!pin.publisher.team || !pin.publisher.project) {
    errors.push('publisher scope must include team and project');
  } else {
    if (!isVercelSlug(pin.publisher.team)) errors.push('publisher team must be a Vercel slug');
    if (!isVercelSlug(pin.publisher.project)) errors.push('publisher project must be a Vercel slug');
  }
  if (!pin.consumer.team || !pin.consumer.project) {
    errors.push('consumer scope must include team and project');
  } else {
    if (!isVercelSlug(pin.consumer.team)) errors.push('consumer team must be a Vercel slug');
    if (!isVercelSlug(pin.consumer.project)) errors.push('consumer project must be a Vercel slug');
  }
  if (reference) {
    if (pin.publisher.team !== reference.team || pin.publisher.project !== reference.project) {
      errors.push('publisher scope must match image reference team and project');
    }
  }
  if (
    pin.publisher.team === pin.consumer.team &&
    pin.publisher.project === pin.consumer.project
  ) {
    errors.push('consumer smoke must use a different Vercel team or project');
  }

  if (pin.testedReference !== pin.reference) {
    errors.push('testedReference must exactly match the promoted image reference');
  }
  if (pin.publisherSmokeStatus !== 'passed') {
    errors.push('publisher smoke evidence is not marked passed');
  }
  if (pin.consumerSmokeStatus !== 'passed') {
    errors.push('consumer smoke evidence is not marked passed');
  }
  if (pin.crossProjectVerified !== true) {
    errors.push('crossProjectVerified must be true before promotion');
  }

  return {
    ok: errors.length === 0,
    reference,
    baseReference,
    errors,
  };
}

/** Throw a compact error when a release pin is not promotable. */
export function assertValidVercelImagePin(pin: VercelImagePin): VercelImageReference {
  const result = validateVercelImagePin(pin);
  if (!result.ok) {
    throw new Error(`Invalid Vercel image pin:\n- ${result.errors.join('\n- ')}`);
  }
  return result.reference!;
}

export const VERCEL_IMAGE_REFERENCE =
  'vcr.vercel.com/devbox-publisher/devbox-image/devbox@sha256:0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Bootstrap metadata is intentionally not release-valid until the secret-gated
 * candidate workflow has produced a real public digest and independent smoke
 * evidence.  The workflow's promotion PR replaces these values atomically.
 */
export const VERCEL_IMAGE_PIN: VercelImagePin = {
  reference: VERCEL_IMAGE_REFERENCE,
  baseReference:
    'vcr.vercel.com/vercel/sandbox/universal@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  baseDigest:
    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  sourceCommit: '0000000000000000000000000000000000000000',
  publisherSmokeUrl: 'https://example.invalid/vercel-publisher-smoke',
  consumerSmokeUrl: 'https://example.invalid/vercel-consumer-smoke',
  publisher: { team: 'devbox-publisher', project: 'devbox-image' },
  consumer: { team: 'devbox-consumer', project: 'devbox-consumer-image' },
  testedReference: VERCEL_IMAGE_REFERENCE,
  publisherSmokeStatus: 'pending',
  consumerSmokeStatus: 'pending',
  crossProjectVerified: false,
};
