import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  VERCEL_IMAGE_PIN,
  assertValidVercelImagePin,
  type VercelImagePin,
  type VercelImageProvenance,
} from './image.js';

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

/** Validate the checked-in pin before a package release is allowed. */
export function validateReleaseImagePin(): void {
  assertValidVercelImagePin(VERCEL_IMAGE_PIN);
  const provenanceRaw = readFileSync(
    new URL('../../../images/vercel/provenance.json', import.meta.url),
    'utf8',
  );
  assertReleaseProvenanceMatches(VERCEL_IMAGE_PIN, provenanceRaw);
}

if (process.argv[1]?.endsWith('/release-validation.js')) {
  try {
    validateReleaseImagePin();
    console.log(`Vercel image pin is release-valid: ${VERCEL_IMAGE_PIN.reference}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
