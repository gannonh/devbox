#!/usr/bin/env node
/**
 * Decide whether a Nightly re-run may point a channel dist-tag at `candidate`.
 *
 * Re-runs that already published skip republish and only finish the GitHub
 * tag/release. Unconditionally `npm dist-tag add`-ing the older version would
 * roll `nightly` / `dev-*` backward after a newer run advanced the channel.
 * Preserve the channel when it already points at a newer version.
 *
 * Prints one of: advance | already | preserve
 * Exits 0 on a valid decision, non-zero on misuse.
 */
import { compareVersions } from './agent-manifest.mjs';

/**
 * @param {string} current  version currently on the channel (empty if unset)
 * @param {string} candidate this run's published version
 * @returns {'advance' | 'already' | 'preserve'}
 */
export function distTagAdvanceDecision(current, candidate) {
  if (typeof candidate !== 'string' || !candidate) {
    throw new Error('candidate version is required');
  }
  if (typeof current !== 'string' || !current) return 'advance';
  if (current === candidate) return 'already';
  return compareVersions(current, candidate) < 0 ? 'advance' : 'preserve';
}

if (process.argv[1]?.endsWith('/should-advance-dist-tag.mjs')) {
  const current = process.env.CURRENT_DIST_TAG ?? '';
  const candidate = process.env.CANDIDATE_VERSION ?? '';
  try {
    process.stdout.write(`${distTagAdvanceDecision(current, candidate)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
