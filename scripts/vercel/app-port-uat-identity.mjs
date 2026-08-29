/**
 * UAT-only recovery for a leftover Vercel sandbox on a stable fixture identity.
 *
 * The production CLI still fails closed on identity conflict: a human must
 * `--rm` the stale box. This helper is the dedicated non-interactive path used
 * by `app-port-uat.mjs` so a previous gate's leftover cannot strand a recut.
 */

export const STALE_SANDBOX_IDENTITY_CONFLICT =
  /The Vercel sandbox identity conflicts with this repository or branch/;

export function isStaleSandboxIdentityConflict(text) {
  return STALE_SANDBOX_IDENTITY_CONFLICT.test(String(text ?? ''));
}

/**
 * Remove any leftover box for this branch, boot, and on a stale-identity
 * conflict remove once more and boot again. Other failures are returned as-is
 * so confirmation refusals and pin mismatches stay hard errors.
 *
 * `boot` and `remove` are caller-owned CLI invocations. This module never
 * talks to Vercel itself.
 */
export async function bootClearingStaleIdentity({ boot, remove }) {
  if (typeof boot !== 'function' || typeof remove !== 'function') {
    throw new TypeError('bootClearingStaleIdentity requires boot and remove functions');
  }

  const preflight = await remove();
  if (preflight.code !== 0) throw removeFailed('preflight-remove', preflight);

  // Confirmation writes repository scope before the identity check. A retry
  // therefore must not require the create prompt; the caller still answers it
  // if it appears.
  const first = await boot({ attempt: 1 });
  if (first.code === 0 || !isStaleSandboxIdentityConflict(first.stderr)) {
    return { ...first, retried: false };
  }

  const conflictRemove = await remove();
  if (conflictRemove.code !== 0) throw removeFailed('conflict-remove', conflictRemove);

  const second = await boot({ attempt: 2 });
  return { ...second, retried: true };
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
