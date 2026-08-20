import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

async function workflowText(): Promise<string> {
  return readFile('.github/workflows/agent-refresh.yml', 'utf8');
}

describe('agent refresh workflow', () => {
  it('runs on a daily schedule and by manual dispatch with an agent filter', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain("cron: '0 4 * * *'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("description: 'Comma-separated agent names to refresh (default: all declared agents)'");
    expect(workflow).toContain('--agents "${AGENT_FILTER}"');
  });

  it('serializes refreshes and gates manual dispatches to the repository owner', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('group: devbox-agent-refresh');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain("github.event_name != 'workflow_dispatch' || github.actor == github.repository_owner");
  });

  it('detects drift credential-free before any write-capable token is minted', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('detect:');
    expect(workflow).toContain('permissions:\n      contents: read');
    expect(workflow).toContain('check-agent-updates.mjs');
    expect(workflow).toContain('has_updates=false');
    expect(workflow).toContain('refresh:');
    expect(workflow).toContain('needs: detect');
    expect(workflow).toContain("needs.detect.outputs.has_updates == 'true'");
    // The refresh job is the only job allowed to write; it is never triggered
    // by a pull request, so PR CI stays credential-free.
    expect(workflow).not.toContain('pull_request:');
  });

  it('never changes the production pin or any image channel itself', async () => {
    const workflow = await workflowText();
    // Promotion is merging the PR; the scheduled Nightly moves the channel.
    expect(workflow).not.toContain('--tag nightly');
    expect(workflow).not.toContain('--tag stable');
    expect(workflow).not.toContain('retag-image.mjs');
    expect(workflow).not.toContain('nightly-pin.mjs');
    expect(workflow).not.toContain('emit-image-pin.mjs');
  });

  it('applies and asserts the manifest contract before building the candidate', async () => {
    const workflow = await workflowText();
    const applyIndex = workflow.indexOf('apply-agent-updates.mjs');
    const assertIndex = workflow.indexOf('assert-agent-manifest.mjs');
    const buildIndex = workflow.indexOf('Build and push linux/amd64 zstd candidate');
    expect(applyIndex).toBeGreaterThan(-1);
    expect(assertIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(assertIndex);
    expect(assertIndex).toBeLessThan(buildIndex);
    // The update report the candidate is built from is re-resolved in this job.
    expect(workflow).toContain('Resolve the update report');
  });

  it('skips a rebuild when the open promotion PR already carries the update', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('agent-update/agents');
    expect(workflow).toContain('cmp -s <(git show "origin/agent-update/agents:images/vercel/agents.json"');
    // A manually filtered run must never clobber a broader open PR; a full
    // run falls through to the content comparison and updates the PR in place.
    expect(workflow).toContain('already covers this refresh');
    expect(workflow).toContain('[[ -n "${open_pr}" && -n "${DISPATCH_AGENT_FILTER:-}" ]]');
    expect(workflow).toContain('--base "${{ github.event.repository.default_branch }}"');
    // The skip gate is only meaningful if the producing step declares the id
    // and every steps.<id>.outputs reference resolves to a declared step id.
    const skipStep = workflow.slice(
      workflow.indexOf('Skip when the open promotion PR is already current'),
      workflow.indexOf('Prepare immutable candidate reference'),
    );
    expect(skipStep).toContain('id: skip');
    const referencedStepIds = [...workflow.matchAll(/steps\.([a-zA-Z_][a-zA-Z0-9_]*)\.outputs/g)]
      .map((match) => match[1]);
    expect(referencedStepIds.length).toBeGreaterThan(0);
    for (const stepId of referencedStepIds) {
      expect(workflow).toMatch(new RegExp(`id: ${stepId}\\b`));
    }
    // gh steps carry the job token explicitly; the skip-step listing must
    // fail visibly instead of falling back to building.
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    const ghListing = skipStep.slice(skipStep.indexOf('gh pr list'), skipStep.indexOf('\n'));
    expect(ghListing).not.toContain('2>/dev/null');
    expect(ghListing).not.toContain('|| true');
  });

  it('runs both exact-digest smoke gates before the promotion PR exists', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('IMAGE_REF: vcr.vercel.com/${{ secrets.VERCEL_PUBLISHER_TEAM_SLUG }}/${{ secrets.VERCEL_PUBLISHER_PROJECT_SLUG }}/${{ env.VERCEL_IMAGE_REPOSITORY }}@${{ steps.manifest.outputs.digest }}');
    expect(workflow).toContain('SMOKE_ROLE: publisher');
    expect(workflow).toContain('SMOKE_ROLE: consumer');
    const publisher = workflow.indexOf('Publisher Sandbox smoke gate');
    const consumer = workflow.indexOf('Independent consumer Sandbox smoke gate');
    const pr = workflow.indexOf('Create or update the promotion PR');
    expect(publisher).toBeGreaterThan(-1);
    expect(consumer).toBeGreaterThan(-1);
    expect(pr).toBeGreaterThan(-1);
    expect(publisher).toBeLessThan(consumer);
    expect(consumer).toBeLessThan(pr);
    // Evidence is redacted and uploaded before the branch is pushed.
    expect(workflow).toContain('redact-artifacts.mjs');
    expect(workflow).toContain('actions/upload-artifact@');
  });

  it('only opens the promotion PR after a fully validated candidate', async () => {
    const workflow = await workflowText();
    const prStep = workflow.slice(workflow.indexOf('Create or update the promotion PR'));
    expect(prStep).toContain('if: steps.skip.outputs.skip != \'true\'');
    expect(prStep).toContain('render-agent-pr-body.mjs');
    expect(prStep).toContain('gh pr create');
    expect(prStep).toContain('gh pr edit');
    // The PR body records the candidate digest and the merge-to-promote rule.
    expect(prStep).toContain('--candidate-digest "${CANDIDATE_DIGEST}"');
    const render = await readFile('scripts/vercel/render-agent-pr-body.mjs', 'utf8');
    expect(render).toContain('Merging this pull request promotes');
  });

  it('consumes the same audited secrets contract as the nightly workflow', async () => {
    const workflow = await workflowText();
    // Publisher secrets map under their exact names (nightly-style); consumer
    // secrets feed the consumer smoke step under the generic names.
    for (const secret of [
      'VERCEL_PUBLISHER_TOKEN',
      'VERCEL_PUBLISHER_TEAM_ID',
      'VERCEL_PUBLISHER_PROJECT_ID',
      'VERCEL_PUBLISHER_TEAM_SLUG',
      'VERCEL_PUBLISHER_PROJECT_SLUG',
    ]) {
      expect(workflow).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
    for (const secret of [
      'VERCEL_CONSUMER_TOKEN',
      'VERCEL_CONSUMER_TEAM_ID',
      'VERCEL_CONSUMER_PROJECT_ID',
      'VERCEL_CONSUMER_TEAM_SLUG',
      'VERCEL_CONSUMER_PROJECT_SLUG',
    ]) {
      expect(workflow).toContain(`\${{ secrets.${secret} }}`);
    }
  });
});
