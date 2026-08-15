/**
 * Recover only resources returned by an owned tag/name query.
 *
 * Cloud-specific stop/delete/verification policy is injected by callers so
 * this discovery seam is deterministic and credential-free in tests.
 */
export async function recoverOwnedResources({
  listSandboxes,
  recoverSandbox,
  listSnapshots,
  deleteSnapshot,
  signal,
}) {
  if (typeof listSandboxes !== 'function' || typeof recoverSandbox !== 'function' ||
      typeof listSnapshots !== 'function' || typeof deleteSnapshot !== 'function') {
    throw new TypeError('owned-resource recovery callbacks are required');
  }
  const errors = [];
  const recoveredSandboxes = [];
  const deletedSnapshots = [];
  let sandboxes = [];
  try {
    sandboxes = await listSandboxes({ signal });
  } catch (error) {
    errors.push(`sandbox discovery: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
  }
  for (const sandbox of Array.isArray(sandboxes) ? sandboxes : []) {
    if (!sandbox || typeof sandbox.name !== 'string' || sandbox.name.length === 0) {
      errors.push('sandbox discovery returned an unidentified resource');
      continue;
    }
    try {
      await recoverSandbox(sandbox.name, { signal });
      recoveredSandboxes.push(sandbox.name);
    } catch (error) {
      errors.push(`sandbox ${sandbox.name} recovery: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    }
  }
  let snapshots = [];
  try {
    snapshots = await listSnapshots({ signal });
  } catch (error) {
    errors.push(`snapshot discovery: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot || typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
      errors.push('snapshot discovery returned an unidentified resource');
      continue;
    }
    if (snapshot.status === 'deleted') continue;
    try {
      await deleteSnapshot(snapshot, { signal });
      deletedSnapshots.push(snapshot.id);
    } catch (error) {
      errors.push(`snapshot ${snapshot.id} cleanup: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
    }
  }
  return { recoveredSandboxes, deletedSnapshots, errors };
}
