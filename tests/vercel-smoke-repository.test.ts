import { describe, expect, it } from 'vitest';
import { validateCloneBranchState } from '../scripts/vercel/smoke-repository.mjs';

describe('provider smoke repository revision checks', () => {
  it('accepts detached HEAD for an existing revision when HEAD is checked separately', () => {
    expect(validateCloneBranchState('', 'fixture-existing', true)).toEqual({
      ok: true,
      state: 'detached',
      observedBranch: '',
    });
  });

  it('requires the created branch for the missing-branch path', () => {
    expect(validateCloneBranchState('', 'devbox-smoke/missing', false).ok).toBe(false);
    expect(validateCloneBranchState('devbox-smoke/missing', 'devbox-smoke/missing', false)).toEqual({
      ok: true,
      state: 'branch',
      observedBranch: 'devbox-smoke/missing',
    });
  });
});
