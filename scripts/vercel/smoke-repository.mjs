/**
 * Validate the branch state reported by a cloned fixture revision.
 * Existing fixture revisions may be checked out detached; missing-branch
 * smoke paths must prove that branch setup created the requested branch.
 */
export function validateCloneBranchState(observedBranch, expectedBranch, allowDetached) {
  const branch = typeof observedBranch === 'string' ? observedBranch.trim() : '';
  return {
    ok: branch === expectedBranch || (allowDetached === true && branch === ''),
    state: branch === '' ? 'detached' : 'branch',
    observedBranch: branch,
  };
}
