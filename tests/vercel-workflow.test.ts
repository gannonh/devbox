import { describe, expect, it } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';

async function workflowText(): Promise<string> {
  return readFile('.github/workflows/vercel-image.yml', 'utf8');
}

async function exists(path: string): Promise<void> {
  await access(path, constants.F_OK);
}

describe('Vercel image supply-chain workflow', () => {
  it('runs manually and on a schedule without an auto-merge path', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain("cron:");
    expect(workflow).toContain('gh pr create');
    expect(workflow).not.toContain('gh pr merge');
    expect(workflow).not.toContain('enable-auto-merge');
  });

  it('runs credentialed PR verification only for a labeled same-repository branch', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    const workflow = await workflowText();
    expect(ci).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(ci).toContain("contains(github.event.pull_request.labels.*.name, 'vercel-image-candidate')");
    expect(ci).toContain('uses: ./.github/workflows/vercel-image.yml');
    expect(ci).toContain('secrets: inherit');
    expect(ci).toMatch(/vercel-image-candidate:[\s\S]*?permissions:\n\s+contents: read/);
    expect(workflow).toContain('propose_promotion:');
    expect(workflow).toContain("github.event_name != 'workflow_call' || inputs.propose_promotion");
  });

  it('builds an amd64 zstd immutable candidate and waits for readiness', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('docker/setup-buildx-action');
    expect(workflow).toContain('vercel@58.11.0');
    expect(workflow).toContain('--platform linux/amd64');
    expect(workflow).toContain('compression=zstd');
    expect(workflow).toContain('sha-${SOURCE_COMMIT}');
    expect(workflow).toContain("SOURCE_COMMIT: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(workflow).toContain("github.event_name != 'workflow_call' || inputs.propose_promotion");
    expect(workflow).toContain('UPSTREAM_COMMIT');
    expect(workflow).toContain('provenance.json');
    expect(workflow).not.toContain('UNIVERSAL_BASE_DIGEST');
    expect(workflow).not.toContain('resolve-universal-digest.mjs');
    expect(workflow).not.toContain('universal_digest');
    expect(workflow).toContain('wait-vcr-ready.mjs');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('SMOKE_TIMEOUT_MS:');
    expect(workflow).toContain('SMOKE_HTTP_TIMEOUT_MS:');
    expect(workflow).toContain('Preparing');
    expect(workflow).toContain('Unoptimized');
    expect(workflow).toContain('image_not_ready');
  });

  it('fails scheduled upstream drift closed before candidate publication', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('git ls-remote https://github.com/vercel/sandbox.git HEAD');
    expect(workflow).toContain('upstream Universal provenance drift');
    expect(workflow).toContain('reviewed provenance update');
    expect(workflow).toContain('steps.provenance.outputs.upstream_commit');
    expect(workflow).toContain('steps.provenance.outputs.ubuntu_base_reference');
  });

  it('serializes immutable tags and makes promotion branch/PR creation idempotent', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('vcr tag inspect');
    expect(workflow).toContain('manifestDigest');
    expect(workflow).toContain('git fetch origin');
    expect(workflow).toContain('gh pr list --state open --head');
    expect(workflow).not.toContain('gh pr view --head');
    expect(workflow).toContain('git diff --cached --quiet');
  });

  it('uses separate publisher and consumer credentials and both exact-digest smoke gates', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('VERCEL_PUBLISHER_TOKEN');
    expect(workflow).toContain('VERCEL_CONSUMER_TOKEN');
    expect(workflow).toContain('VERCEL_PUBLISHER_PROJECT_ID');
    expect(workflow).toContain('VERCEL_CONSUMER_PROJECT_ID');
    expect(workflow).toContain('VERCEL_CONSUMER_TOKEN');
    expect(workflow).toContain('VERCEL_CONSUMER_TEAM_SLUG');
    expect(workflow).toContain('VERCEL_CONSUMER_PROJECT_SLUG');
    expect(workflow).toContain('consumer token must be different');
    expect(workflow).toContain('assert-public-repository.mjs');
    expect(workflow).toContain('--scope "${VERCEL_PUBLISHER_TEAM_SLUG}"');
    expect(workflow).toContain('assert-project-identity.mjs');
    expect(workflow).toContain('vercel teams list');
    expect(workflow).toContain('--expected-team-id');
    expect(workflow).toContain('--expected-project-id');
    expect(workflow).toContain('smoke-sandbox.mjs');
    expect(workflow).toContain('SMOKE_ROLE: publisher');
    expect(workflow).toContain('SMOKE_ROLE: consumer');
    expect(workflow).toContain('EXPECTED_IMAGE_DIGEST');
    expect(workflow).toContain('snapshot');
    expect(workflow).toContain('deleted');
    expect(workflow).toContain('--publisher-evidence');
    expect(workflow).toContain('--consumer-evidence');
    expect(workflow).toContain('build-timing.json');
    expect(workflow).toContain('manifest-timing.json');
  });

  it('redacts workflow evidence and promotes only after both smoke gates', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('redact-artifacts.mjs');
    expect(workflow).toContain('id: redact_final');
    expect(workflow).toContain("if: ${{ always() && steps.redact_final.outcome == 'success' && steps.redact_publisher.outcome != 'failure' }}");
    expect(workflow).toContain('promote-image.mjs');
    expect(workflow).toContain('cross-project');
    expect(workflow).toContain('redacted');
    const publisherRedact = workflow.match(/- name: Redact publisher evidence[\s\S]*?(?=\n\s{6}- name:)/)?.[0] ?? '';
    const finalRedact = workflow.match(/- name: Redact all evidence[\s\S]*?(?=\n\s{6}- name:)/)?.[0] ?? '';
    const buildStep = workflow.match(/- name: Build and push linux\/amd64 zstd candidate[\s\S]*?(?=\n\s{6}- name:)/)?.[0] ?? '';
    for (const block of [publisherRedact, finalRedact, buildStep]) {
      expect(block).toContain('VERCEL_PUBLISHER_TOKEN');
      expect(block).toContain('VERCEL_CONSUMER_TOKEN');
    }
    const smoke = await readFile('scripts/vercel/smoke-sandbox.mjs', 'utf8');
    const cleanup = await readFile('scripts/vercel/sandbox-cleanup.mjs', 'utf8');
    expect(smoke).toContain('sessionStates');
    expect(smoke).toContain('finalSessionStatesTerminal');
    expect(smoke).toContain('discoveryConverged');
    expect(smoke).toContain('recoverOwnedResources');
    expect(smoke).toContain('devbox-run');
    expect(cleanup).toContain('resume: false');
    expect(cleanup).toContain('after-delete');
    for (const stage of ['startup', 'http', 'websocket', 'terminal', 'stop', 'delete']) {
      expect(smoke).toContain(`timed('${stage}'`);
    }
    expect(workflow).toMatch(/if: \$\{\{ success\(\)/);
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('pull-requests: write');
  });

  it('documents scoped all-resource orphan cleanup and a long-lived local runtime', async () => {
    const runbook = await readFile('docs/runbooks/vercel-image-supply-chain.md', 'utf8');
    const imageReadme = await readFile('images/vercel/README.md', 'utf8');
    expect(runbook).toContain('sandbox list --all');
    expect(runbook).toContain('sandbox snapshots list');
    expect(runbook).toContain('vercel@58.11.0 sandbox snapshots delete');
    expect(runbook).toContain('devbox-smoke-publisher-');
    expect(runbook).toContain('devbox-smoke-consumer-');
    expect(runbook).toContain('provenance.json');
    expect(runbook).toContain('UPSTREAM_COMMIT');
    expect(runbook).toContain('--scope');
    expect(runbook).toContain('--tag');
    expect(runbook).toContain('sleep infinity');
    expect(imageReadme).toContain('sleep infinity');
  });

  it('documents mirrored Universal provenance and reviewed upstream updates', async () => {
    const workflow = await workflowText();
    const runbook = await readFile('docs/runbooks/vercel-image-supply-chain.md', 'utf8');
    const imageReadme = await readFile('images/vercel/README.md', 'utf8');
    expect(workflow).toContain('provenance.json');
    expect(workflow).toContain('git -C "${upstream_checkout}" fetch');
    expect(workflow).toContain('pinned upstream Ubuntu Dockerfile hash mismatch');
    expect(workflow).toContain('pinned upstream Universal Dockerfile hash mismatch');
    expect(workflow).not.toContain('base-digest.json');
    expect(runbook).toContain('provenance.json');
    expect(runbook).toContain('upstream recipe');
    expect(runbook).toContain('reviewed provenance update');
    expect(runbook).not.toContain('universal_digest');
    expect(imageReadme).toContain('provenance.json');
    expect(imageReadme).not.toContain('UNIVERSAL_BASE_DIGEST');
  });

  it('documents the audited Vercel CLI version contract', async () => {
    const runbook = await readFile('docs/runbooks/vercel-image-supply-chain.md', 'utf8');
    expect(runbook).toContain('58.11.0');
    expect(runbook).toContain('CLI version');
  });

  it('ships the workflow helper scripts', async () => {
    await Promise.all([
      exists('images/vercel/provenance.json'),
      exists('scripts/vercel/wait-vcr-ready.mjs'),
      exists('scripts/vercel/smoke-sandbox.mjs'),
      exists('scripts/vercel/smoke-contract.mjs'),
      exists('scripts/vercel/http-probe.mjs'),
      exists('scripts/vercel/sandbox-cleanup.mjs'),
      exists('scripts/vercel/assert-project-identity.mjs'),
      exists('scripts/vercel/assert-candidate-tag.mjs'),
      exists('scripts/vercel/promote-image.mjs'),
      exists('scripts/vercel/redact-artifacts.mjs'),
    ]);
  });

  it('reports an actionable bounded-timeout readiness fixture', async () => {
    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ['scripts/vercel/wait-vcr-ready.mjs'],
        {
          env: {
            ...process.env,
            VERCEL_IMAGE_REPOSITORY: 'devbox',
            VERCEL_IMAGE_TAG: 'fixture',
            VERCEL_PUBLISHER_PROJECT_ID: 'project',
            VERCEL_PUBLISHER_TEAM_SLUG: 'publisher-team',
            VCR_READINESS_FIXTURE: '["Preparing"]',
            READINESS_TIMEOUT_MS: '20',
            READINESS_POLL_MS: '1',
          },
        },
        (error, _stdout, stderr) => resolve({ code: error?.code ? Number(error.code) : 0, stderr }),
      );
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Timed out');
    expect(result.stderr).toContain('Preparing');
  });
});
