/**
 * UAT-only recovery for leftover Vercel sandboxes on a stable fixture identity.
 *
 * The production CLI still fails closed on identity conflict and on multiple
 * live matches for the same repository and branch: a human must `--rm` the
 * exact resource. This helper is the dedicated non-interactive path used by
 * `app-port-uat.mjs` so a previous gate's leftover cannot strand a recut.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_MS = 250;

export const STALE_SANDBOX_IDENTITY_CONFLICT =
  /The Vercel sandbox identity conflicts with this repository or branch/;

export const AMBIGUOUS_SANDBOX_REMOVAL =
  /Multiple live Vercel sandboxes match this repository and branch; do not run automatic removal/;

export function isStaleSandboxIdentityConflict(text) {
  return STALE_SANDBOX_IDENTITY_CONFLICT.test(String(text ?? ''));
}

export function isAmbiguousSandboxRemoval(text) {
  return AMBIGUOUS_SANDBOX_REMOVAL.test(String(text ?? ''));
}

/**
 * Remove every leftover whose identity tag matches this fixture, then prove
 * the listing is empty. Foreign-scope names are reported and never cleaned.
 *
 * `inspect` and `cleanup` are caller-owned. This module never talks to Vercel.
 * A verified delete can still appear in the next collection listing, so leftover
 * inspects retry for a bounded window before failing closed.
 */
export async function removeEachMatchingLeftover({
  inspect,
  cleanup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  sleep = wait,
}) {
  if (typeof inspect !== 'function' || typeof cleanup !== 'function') {
    throw new TypeError('removeEachMatchingLeftover requires inspect and cleanup functions');
  }
  validateRelistOptions({ timeoutMs, maxAttempts, backoffMs, sleep });

  const listed = await inspect();
  const matches = listedMatches(listed);
  const foreignScope = Array.isArray(listed?.foreignScope) ? listed.foreignScope : [];
  const removed = [];
  for (const record of matches) {
    const result = await cleanup(record);
    if (!result?.verified) {
      throw matchingRemoveFailed(record, result);
    }
    removed.push(record.name);
  }

  const leftover = await waitForEmptyMatches({
    inspect,
    timeoutMs,
    maxAttempts,
    backoffMs,
    sleep,
  });
  if (leftover.length > 0) {
    const error = new Error(
      `matching-remove left ${leftover.length} live sandbox(es) for this repository and branch`,
    );
    error.phase = 'matching-remove';
    error.leftover = leftover;
    throw error;
  }

  return { removed, foreignScope };
}

/**
 * Remove any leftover box for this branch, boot, and on a stale-identity
 * conflict remove once more and boot again. Other failures are returned as-is
 * so confirmation refusals and pin mismatches stay hard errors.
 *
 * When `--rm` aborts because more than one live sandbox shares the fixture
 * identity, `removeMatching` clears each match by exact name. Interactive
 * `--rm` stays fail-closed; this fallback is UAT-only.
 *
 * `boot`, `remove`, and `removeMatching` are caller-owned CLI / listing
 * invocations. This module never talks to Vercel itself.
 */
export async function bootClearingStaleIdentity({ boot, remove, removeMatching }) {
  if (typeof boot !== 'function' || typeof remove !== 'function') {
    throw new TypeError('bootClearingStaleIdentity requires boot and remove functions');
  }

  let clearedDuplicates = false;
  const preflight = await remove();
  if (preflight.code !== 0) {
    await clearAmbiguousOrThrow('preflight-remove', preflight, removeMatching);
    clearedDuplicates = true;
  }

  // Confirmation writes repository scope before the identity check. A retry
  // therefore must not require the create prompt; the caller still answers it
  // if it appears.
  const first = await boot({ attempt: 1 });
  if (first.code === 0 || !isStaleSandboxIdentityConflict(first.stderr)) {
    return { ...first, retried: false, clearedDuplicates };
  }

  const conflictRemove = await remove();
  if (conflictRemove.code !== 0) {
    await clearAmbiguousOrThrow('conflict-remove', conflictRemove, removeMatching);
    clearedDuplicates = true;
  }

  const second = await boot({ attempt: 2 });
  return { ...second, retried: true, clearedDuplicates };
}

async function clearAmbiguousOrThrow(phase, result, removeMatching) {
  if (!isAmbiguousSandboxRemoval(result?.stderr) || typeof removeMatching !== 'function') {
    throw removeFailed(phase, result);
  }
  await removeMatching();
}

function matchingRemoveFailed(record, result) {
  const name = typeof record?.name === 'string' && record.name.trim()
    ? record.name.trim()
    : '<unnamed>';
  const error = new Error(`matching-remove did not verify ${name}`);
  error.phase = 'matching-remove';
  error.result = result;
  return error;
}

function removeFailed(phase, result) {
  const detail = String(result?.stderr ?? '').trim().split('\n').at(-1) ?? '';
  const error = new Error(
    detail
      ? `${phase} exited ${result.code}: ${detail}`
      : `${phase} exited ${result.code}`,
  );
  error.phase = phase;
  error.result = result;
  return error;
}

function listedMatches(listed) {
  return Array.isArray(listed?.matches) ? listed.matches : [];
}

function validateRelistOptions({ timeoutMs, maxAttempts, backoffMs, sleep }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('removeEachMatchingLeftover timeoutMs must be positive');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('removeEachMatchingLeftover maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new TypeError('removeEachMatchingLeftover backoffMs must be non-negative');
  }
  if (typeof sleep !== 'function') {
    throw new TypeError('removeEachMatchingLeftover requires a sleep function');
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Relist until the collection is empty or the owned-resource retry budget is
 * spent. cleanupVercelSandbox can verify deletion while list still returns the
 * deleted record; a single immediate inspect is not proof of leftover.
 */
async function waitForEmptyMatches({ inspect, timeoutMs, maxAttempts, backoffMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  let leftover = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    leftover = listedMatches(await inspect());
    if (leftover.length === 0) return leftover;
    if (attempt >= maxAttempts) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const delay = Math.min(backoffMs * attempt, remaining);
    if (delay > 0) await sleep(delay);
  }
  return leftover;
}
