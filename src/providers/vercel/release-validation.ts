import { VERCEL_IMAGE_PIN, assertValidVercelImagePin } from './image.js';

/** Validate the checked-in pin before a package release is allowed. */
export function validateReleaseImagePin(): void {
  assertValidVercelImagePin(VERCEL_IMAGE_PIN);
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
