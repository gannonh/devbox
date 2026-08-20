#!/usr/bin/env node
/**
 * Render the agent-refresh promotion PR body.
 *
 * The PR is the reviewable promotion artifact: it records the declared vs
 * candidate versions for every refreshed agent, the exact candidate digest
 * that passed both smoke gates, and the merge guidance (the scheduled Nightly
 * rebuilds this identical image content and moves the nightly channel).
 */
export function renderAgentPrBody({ report, candidateDigest, runUrl }) {
  const rows = report.agents
    .filter((entry) => report.updates.includes(entry.name))
    .map((entry) => `| ${entry.name} | \`${entry.declared}\` | \`${entry.latest}\` |`)
    .join('\n');
  return [
    '## Agent version refresh',
    '',
    'A validated candidate image carries the declared coding-agent updates. Merging this pull request promotes it: the scheduled **Nightly** run builds this exact image content and moves the `nightly` channel to the same digest. Until then the production pin is unchanged.',
    '',
    '| Agent | Declared | Candidate |',
    '| --- | --- | --- |',
    rows,
    '',
    `- Candidate digest: \`${candidateDigest}\``,
    `- Validation: publisher and consumer Sandbox smoke gates passed against the exact digest (${runUrl}), plus the manifest contract, zstd manifest, and VCR readiness checks.`,
    '- Rollback: revert this PR (or dispatch **Release** naming an earlier known-good nightly) to move back to the previous digest without rebuilding.',
    '',
  ].join('\n');
}

if (process.argv[1]?.endsWith('/render-agent-pr-body.mjs')) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    if (!key?.startsWith('--') || !process.argv[index + 1]) throw new Error(`missing value for ${key ?? 'argument'}`);
    args.set(key.slice(2), process.argv[index + 1]);
  }
  const { readFile } = await import('node:fs/promises');
  const report = JSON.parse(await readFile(args.get('report'), 'utf8'));
  const digest = args.get('candidate-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('--candidate-digest must be a full sha256 digest');
  const runUrl = args.get('run-url');
  if (!/^https:\/\/github\.com\/.+/.test(runUrl ?? '')) throw new Error('--run-url must be an HTTPS GitHub URL');
  process.stdout.write(renderAgentPrBody({ report, candidateDigest: digest, runUrl }));
}
