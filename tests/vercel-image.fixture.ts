import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  VERCEL_IMAGE_PROVENANCE,
  type VercelImagePin,
} from '../src/providers/vercel/image.js';

/**
 * Image fixtures for tests.
 *
 * The pin is a build output rather than source, so tests supply their own
 * reference instead of reading a checked-in constant. Anything that just needs
 * "a valid image" uses TEST_IMAGE_REFERENCE; anything constructing a lifecycle
 * injects resolveTestImage so it never reaches the registry.
 */

export const TEST_IMAGE_REFERENCE =
  'vcr.vercel.com/astro-labs/devbox/devbox@sha256:d7f2d914ce5905cac6bd0ede396039fe9abc7eb651f82289a917c6e173be6d07';

export const resolveTestImage = async (): Promise<string> => TEST_IMAGE_REFERENCE;

const provenanceRaw = readFileSync(
  new URL('../images/vercel/provenance.json', import.meta.url),
  'utf8',
);

/** A pin shaped exactly as scripts/vercel/emit-image-pin.mjs emits one. */
export const TEST_IMAGE_PIN: VercelImagePin = {
  reference: TEST_IMAGE_REFERENCE,
  provenance: JSON.parse(provenanceRaw) as typeof VERCEL_IMAGE_PROVENANCE,
  provenanceDigest: `sha256:${createHash('sha256').update(provenanceRaw).digest('hex')}`,
  sourceCommit: '8077cb4e51680c25a7d8fa2c0db5a67d141f4588',
  publisherSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/32197069706#publisher-smoke',
  consumerSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/32197069706#consumer-smoke',
  publisher: { team: 'astro-labs', project: 'devbox' },
  consumer: { team: 'astro-labs', project: 'devbox-uat' },
  testedReference: TEST_IMAGE_REFERENCE,
  publisherSmokeStatus: 'passed',
  consumerSmokeStatus: 'passed',
  crossProjectVerified: true,
};
