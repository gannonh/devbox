/* global URL */

const SECRET_MARKER = /(?:token|secret|password|passwd|auth|credential|private|key|signature|sig|jwt|bearer|access)/i;
const SAFE_FRAGMENT = /^#[a-z0-9][a-z0-9._-]*$/i;

/**
 * Validate a workflow/release evidence URL without permitting credentials or
 * secret-bearing query/fragment data to enter package metadata.
 */
export function isStrictEvidenceUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return false;
    // Evidence links do not need query parameters; rejecting them entirely
    // avoids silently publishing an unknown secret-bearing parameter.
    if (url.search) return false;
    if (url.hash && (!SAFE_FRAGMENT.test(url.hash) || SECRET_MARKER.test(url.hash))) return false;
    return true;
  } catch {
    return false;
  }
}
