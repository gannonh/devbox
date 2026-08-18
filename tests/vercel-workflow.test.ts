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
  it('provides a branch when the exact-SHA benchmark checkout is detached', async () => {
    const workflow = await readFile('.github/workflows/vercel-benchmark.yml', 'utf8');

    expect(workflow).toContain('ref: ${{ env.SOURCE_SHA }}');
    expect(workflow).toContain('SOURCE_BRANCH: ${{ github.event.repository.default_branch }}');
  });

  it('serializes the secret-gated provider workflows at the project level', async () => {
    const [benchmark, uat] = await Promise.all([
      readFile('.github/workflows/vercel-benchmark.yml', 'utf8'),
      readFile('.github/workflows/vercel-provider-uat.yml', 'utf8'),
    ]);

    expect(benchmark).toContain('group: vercel-provider-gates');
    expect(uat).toContain('group: vercel-provider-gates');
    expect(benchmark).toContain('cancel-in-progress: false');
    expect(uat).toContain('cancel-in-progress: false');
  });

  it('chains owner-authorized PR smoke, UAT, and benchmark gates', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(ci).toContain('vercel-provider-uat:');
    expect(ci).toContain('vercel-provider-benchmark:');
    expect(ci).toContain('needs: vercel-provider-smoke');
    expect(ci).toContain('needs: vercel-provider-uat');
    expect(ci).toContain("github.event.label.name == format('psmoke:{0}', github.event.pull_request.head.sha)");
    for (const secret of [
      'DEVBOX_UAT_PUSH_TOKEN',
      'DEVBOX_UAT_ENV_CONTENT',
      'DEVBOX_UAT_FIXTURE_COMMAND',
      'DEVBOX_UAT_RESUME_COMMAND',
    ]) {
      expect(ci).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
  });

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

  it('binds credentialed PR verification to a maintainer-applied exact-SHA label', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    const workflow = await workflowText();
    expect(ci).toContain("github.event.action == 'labeled'");
    expect(ci).toContain('github.actor == github.repository_owner');
    expect(ci).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(ci).toContain("github.event.label.name == format('vcr:{0}', github.event.pull_request.head.sha)");
    expect(ci).toContain('uses: ./.github/workflows/vercel-image.yml');
    expect(ci).not.toContain('secrets: inherit');
    expect(ci).toMatch(/vercel-image-candidate:[\s\S]*?permissions:\n\s+contents: write\n\s+pull-requests: write/);
    expect(workflow).toMatch(/candidate:[\s\S]*?permissions:\n\s+contents: read/);
    expect(workflow).toMatch(/promotion:[\s\S]*?github\.event_name != 'pull_request'/);
    for (const secret of [
      'VERCEL_PUBLISHER_TOKEN', 'VERCEL_PUBLISHER_TEAM_ID', 'VERCEL_PUBLISHER_PROJECT_ID',
      'VERCEL_PUBLISHER_TEAM_SLUG', 'VERCEL_PUBLISHER_PROJECT_SLUG', 'VERCEL_CONSUMER_TOKEN',
      'VERCEL_CONSUMER_TEAM_ID', 'VERCEL_CONSUMER_PROJECT_ID', 'VERCEL_CONSUMER_TEAM_SLUG',
      'VERCEL_CONSUMER_PROJECT_SLUG',
    ]) {
      expect(ci).toContain(`${secret}: \${{ secrets.${secret} }}`);
      expect(workflow).toMatch(new RegExp(`${secret}:[\\s\\S]*?required: true`));
    }
    expect(workflow).not.toContain('propose_promotion:');
    expect(workflow).not.toContain('inputs.propose_promotion');
    expect(workflow).toContain("github.event_name != 'pull_request'");
  });

  it('authorizes provider smoke only from an owner exact-head label with explicit read-only secrets', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('vercel-provider-smoke:');
    expect(ci).toContain("github.event.action == 'labeled'");
    expect(ci).toContain('github.actor == github.repository_owner');
    expect(ci).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(ci).toContain("github.event.label.name == format('psmoke:{0}', github.event.pull_request.head.sha)");
    expect(ci).toContain('uses: ./.github/workflows/vercel-provider-smoke.yml');
    expect(ci).toContain('source_sha: ${{ github.event.pull_request.head.sha }}');
    expect(ci).toContain('path: both');
    expect(ci).not.toContain('secrets: inherit');
    expect(ci).not.toContain('pull_request_target');
    expect(ci).toMatch(/vercel-provider-smoke:[\s\S]*?permissions:\n\s+contents: read[\s\S]*?uses: \.\/\.github\/workflows\/vercel-provider-smoke\.yml/);
    for (const secret of [
      'VERCEL_CONSUMER_TOKEN',
      'VERCEL_CONSUMER_TEAM_ID',
      'VERCEL_CONSUMER_PROJECT_ID',
      'DEVBOX_GITHUB_FIXTURE_TOKEN',
      'DEVBOX_GITHUB_FIXTURE_REPOSITORY',
      'DEVBOX_GITHUB_FIXTURE_BRANCH',
      'DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH',
      'DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE',
      'DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT',
    ]) {
      expect(ci).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
    // The generic Vercel triad secret names are absent from the repository and
    // must never be referenced by the caller; the smoke script still receives
    // the exact generic names in its environment from the consumer secrets.
    expect(ci).not.toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(ci).not.toContain('VERCEL_TEAM_ID: ${{ secrets.VERCEL_TEAM_ID }}');
    expect(ci).not.toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}');
  });

  it('documents exact provider-smoke authorization and stale-label behavior', async () => {
    const runbook = await readFile('docs/runbooks/vercel-image-supply-chain.md', 'utf8');
    expect(runbook).toContain('psmoke:<40-character-head-SHA>');
    expect(runbook).toContain('psmoke:${head_sha}');
    expect(runbook).toContain('gh pr edit <number> --add-label');
    expect(runbook).toContain('synchronize');
    expect(runbook).toContain('new exact-SHA label');
    expect(runbook).toContain('authorization only');
    expect(runbook).toContain('not a pass');
  });

  it('builds an amd64 zstd immutable candidate and waits for readiness', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('docker/setup-buildx-action');
    expect(workflow).toContain("github.event_name != 'workflow_dispatch'");
    expect(workflow).toContain('github.actor == github.repository_owner');
    expect(workflow).toContain('github.ref_name == github.event.repository.default_branch');
    expect(workflow).toContain('vercel@58.11.0');
    expect(workflow).toContain('--platform linux/amd64');
    expect(workflow).toContain('--provenance=false');
    expect(workflow).toContain('compression=zstd');
    expect(workflow).toContain('sha-${SOURCE_COMMIT}');
    expect(workflow).toContain('${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}');
    expect(workflow).toContain("SOURCE_COMMIT: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(workflow).toContain("github.event_name != 'pull_request'");
    expect(workflow).toContain('UPSTREAM_COMMIT');
    expect(workflow).toContain('provenance.json');
    expect(workflow).not.toContain('UNIVERSAL_BASE_DIGEST');
    expect(workflow).not.toContain('resolve-universal-digest.mjs');
    expect(workflow).not.toContain('universal_digest');
    expect(workflow).toContain('wait-vcr-ready.mjs');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain('SMOKE_TIMEOUT_MS:');
    expect(workflow).toContain('SMOKE_HTTP_TIMEOUT_MS:');
    expect(workflow).toContain('ARTIFACT_DIR=${artifact_dir}');
    expect(workflow).toContain('READINESS_TIMEOUT_MINUTES');
    expect(workflow).not.toMatch(/fromJSON\([^\n]+\)\s*\*/);
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
    expect(workflow).not.toContain("if: ${{ steps.drift.outputs.skip != 'true' }}");
    expect(workflow.match(/if: \$\{\{ success\(\) && steps\.drift\.outputs\.skip != 'true' \}\}/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it('validates the complete mirrored provenance inventory before building', async () => {
    const workflow = await workflowText();
    for (const value of ['observedManagedVmi', 'runtimePackages', 'chromium', 'requiredRuntimePackages']) {
      expect(workflow).toContain(value);
    }
    expect(workflow).toContain('managedVersions[name] === runtimePackages[name]');
  });

  it('builds every run to a unique immutable tag and makes promotion idempotent', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('Check immutable candidate tag');
    expect(workflow).not.toContain("steps.tag.outputs.exists != 'true'");
    expect(workflow).toContain('vcr tag inspect');
    expect(workflow).toContain('assert-candidate-tag.mjs');
    expect(workflow).toContain('git fetch origin');
    expect(workflow).toContain('gh pr list --state open --head');
    expect(workflow).not.toContain('gh pr view --head');
    expect(workflow).toContain('git diff --quiet -- src/providers/vercel/image.ts');
    expect(workflow).toContain('promotion source already matches the reviewed pin');
    expect(workflow).toContain('existing promotion branch is not rooted at the verified source commit');
    expect(workflow).toContain('existing promotion branch changes files outside the generated pin');
    expect(workflow).toContain('exit 0');
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
    expect(workflow).toContain('vercel api "/v9/projects/${VERCEL_PUBLISHER_PROJECT_ID}"');
    expect(workflow).toContain('vercel api "/v9/projects/${VERCEL_CONSUMER_PROJECT_ID}"');
    expect(workflow).not.toContain('vercel project list');
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
    expect(workflow).toContain('manifest-raw.json');
    expect(workflow).toContain('manifest-compression.json');
    expect(workflow).toContain('assert-zstd-manifest.mjs');
    const zstdAssertion = await readFile('scripts/vercel/assert-zstd-manifest.mjs', 'utf8');
    expect(zstdAssertion).toContain('application/vnd.oci.image.layer.v1.tar+zstd');
  });

  it('redacts workflow evidence and promotes only after both smoke gates', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('redact-artifacts.mjs');
    expect(workflow).toContain('id: redact_final');
    expect(workflow).toContain("if: ${{ always() && steps.redact_final.outcome == 'success' && steps.redact_publisher.outcome != 'failure' }}");
    expect(workflow).toContain('promote-image.mjs');
    expect(workflow).toContain('PROVENANCE_FILE: ${{ runner.temp }}/vercel-image-evidence/provenance.json');
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
    expect(workflow).toMatch(/if: >-\n\s+needs\.candidate\.result == 'success'/);
    expect(workflow).toMatch(/candidate:[\s\S]*?permissions:\n\s+contents: read/);
    expect(workflow).toMatch(/promotion:[\s\S]*?permissions:\n\s+contents: write\n\s+pull-requests: write/);
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
    expect(runbook).toContain('job timeout is 45 minutes');
    expect(runbook).toContain('six 2-minute cleanup phases');
    expect(runbook).toContain('preflight list with a short smoke name prefix');
    expect(runbook).toContain('all five identity tags are checked locally');
    expect(runbook).toContain('existing revision may report detached `HEAD`');
    expect(runbook).toContain('Returned Sandbox images are checked by exact manifest digest');
    expect(runbook).toContain('production Ctrl-] escape byte');
    expect(runbook).toContain('reason `escape`');
    expect(runbook).toContain('does not use a remote shell exit');
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

  it('pins every credentialed-workflow action to a full commit SHA', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    const workflow = await workflowText();
    for (const text of [ci, workflow]) {
      for (const line of text.split('\n').filter((value) => value.trim().startsWith('uses: ') && !value.includes('./.github/'))) {
        expect(line).toMatch(/uses: [^@]+@[a-f0-9]{40}(?:\s+#.*)?$/);
      }
    }
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
      exists('scripts/vercel/assert-zstd-manifest.mjs'),
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
