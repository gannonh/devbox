import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  type VercelImagePin,
  type VercelImageProvenance,
} from './image.js';
import { readReleasePin } from './image-resolution.js';

export function assertReleaseProvenanceMatches(
  pin: VercelImagePin,
  provenanceRaw: string,
): void {
  const digest = `sha256:${createHash('sha256').update(provenanceRaw).digest('hex')}`;
  if (pin.provenanceDigest !== digest) {
    throw new Error('Vercel image pin provenanceDigest does not match images/vercel/provenance.json');
  }
  let provenance: VercelImageProvenance;
  try {
    provenance = JSON.parse(provenanceRaw) as VercelImageProvenance;
  } catch {
    throw new Error('images/vercel/provenance.json is not valid JSON');
  }
  if (JSON.stringify(pin.provenance) !== JSON.stringify(provenance)) {
    throw new Error('Vercel image pin provenance does not match images/vercel/provenance.json');
  }
}

/**
 * Validate the emitted pin before a package release is allowed.
 *
 * The pin is a build output, so a checkout has none: this gate is what stops a
 * release being cut without the smoke evidence that produced a digest.
 */
export function validateReleaseImagePin(): VercelImagePin {
  const pin = readReleasePin();
  if (!pin) {
    throw new Error(
      'No Vercel image pin was emitted for this build. '
      + 'Run scripts/vercel/emit-image-pin.mjs with validated smoke evidence before releasing.',
    );
  }
  const provenanceRaw = readFileSync(
    new URL('../../../images/vercel/provenance.json', import.meta.url),
    'utf8',
  );
  assertReleaseProvenanceMatches(pin, provenanceRaw);
  return pin;
}

if (process.argv[1]?.endsWith('/release-validation.js')) {
  try {
    const pin = validateReleaseImagePin();
    console.log(`Vercel image pin is release-valid: ${pin.reference}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
