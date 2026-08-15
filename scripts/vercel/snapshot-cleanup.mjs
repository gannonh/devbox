import { boundedCall } from './sandbox-cleanup.mjs';

/**
 * Resolve plain Snapshot.list metadata through Snapshot.get before deletion.
 * The caller supplies the SDK-specific get seam so this helper can be tested
 * with the pinned SDK without coupling cleanup to credential ownership.
 */
export async function deleteListedSnapshot({
  snapshot,
  getSnapshot,
  signal,
  timeoutMs,
  label = 'snapshot',
}) {
  if (!snapshot || typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
    throw new Error(`${label} metadata has no id`);
  }
  if (typeof getSnapshot !== 'function') throw new TypeError('getSnapshot callback is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('snapshot cleanup timeout must be positive');
  const instance = await boundedCall(
    (requestSignal) => getSnapshot(snapshot.id, requestSignal),
    `${label} ${snapshot.id} lookup`,
    { signal, timeoutMs },
  );
  await boundedCall(
    (requestSignal) => instance.delete({ signal: requestSignal }),
    `${label} ${snapshot.id} deletion`,
    { signal, timeoutMs },
  );
}
