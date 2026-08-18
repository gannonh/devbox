import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
import {
  hasPreflightSandboxProof,
  isExactSmokeSandboxRecord,
  selectSmokeOwnedSandboxes,
} from '../scripts/vercel/smoke-reconciliation.mjs';
import {
  assertPromotedVercelImagePin,
  calculateVercelProviderSmokeBudget,
  parseVercelProviderSmokeConfig,
  REQUIRED_VERCEL_PROVIDER_SMOKE_ENV,
} from '../src/providers/vercel/smoke-config.js';

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    VERCEL_TOKEN: 'vercel-token',
    VERCEL_TEAM_ID: 'team-id',
    VERCEL_PROJECT_ID: 'project-id',
    DEVBOX_GITHUB_FIXTURE_TOKEN: 'github-token',
    DEVBOX_GITHUB_FIXTURE_REPOSITORY: 'acme/private-fixture',
    DEVBOX_GITHUB_FIXTURE_BRANCH: 'fixture-existing',
    DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH: 'main',
    DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE: 'fixture.txt',
    DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT: 'private fixture content',
    SMOKE_PATH: 'both',
    SMOKE_REPORT: '/tmp/provider-smoke.json',
    ...overrides,
  };
}

// The nine secret-backed fixture/credential inputs shared by the caller and
// the reusable smoke workflow. The Vercel triad is sourced from the verified
// Issue #4 VERCEL_CONSUMER_* secrets; the script environment keeps the exact
// generic VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID names through
// PROVIDER_SMOKE_SECRET_TO_ENV.
const VALID_FIXTURE_SECRET_NAMES = [
  'DEVBOX_GITHUB_FIXTURE_TOKEN',
  'DEVBOX_GITHUB_FIXTURE_REPOSITORY',
  'DEVBOX_GITHUB_FIXTURE_BRANCH',
  'DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH',
  'DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE',
  'DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT',
] as const;

const PROVIDER_SMOKE_SECRETS = [
  'VERCEL_CONSUMER_TOKEN',
  'VERCEL_CONSUMER_TEAM_ID',
  'VERCEL_CONSUMER_PROJECT_ID',
  'DEVBOX_GITHUB_FIXTURE_TOKEN',
  'DEVBOX_GITHUB_FIXTURE_REPOSITORY',
  'DEVBOX_GITHUB_FIXTURE_BRANCH',
  'DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH',
  'DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE',
  'DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT',
] as const;

// Exact mapping from each workflow secret interface name to the script
// environment name that receives its value in the smoke and redaction steps.
const PROVIDER_SMOKE_SECRET_TO_ENV: Record<string, string> = {
  VERCEL_CONSUMER_TOKEN: 'VERCEL_TOKEN',
  VERCEL_CONSUMER_TEAM_ID: 'VERCEL_TEAM_ID',
  VERCEL_CONSUMER_PROJECT_ID: 'VERCEL_PROJECT_ID',
  DEVBOX_GITHUB_FIXTURE_TOKEN: 'DEVBOX_GITHUB_FIXTURE_TOKEN',
  DEVBOX_GITHUB_FIXTURE_REPOSITORY: 'DEVBOX_GITHUB_FIXTURE_REPOSITORY',
  DEVBOX_GITHUB_FIXTURE_BRANCH: 'DEVBOX_GITHUB_FIXTURE_BRANCH',
  DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH: 'DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH',
  DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE: 'DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE',
  DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT: 'DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT',
};

// Parse a workflow YAML structurally (js-yaml is a transitive dep via
// vitest/eslint; dynamic import keeps it out of package.json dependencies),
// matching the existing release-workflow contract test pattern.
async function loadWorkflow(path: string): Promise<Record<string, unknown>> {
  const yaml = await import('js-yaml');
  const content = await readFile(path, 'utf8');
  return yaml.load(content) as Record<string, unknown>;
}

describe('Vercel provider smoke configuration', () => {
  it('selects only strict smoke-owned identities for preflight cleanup', () => {
    const repositoryTag = 'github-com-acme-private-fixture-abcdef1234567890';
    const valid = {
      name: 'devbox-vercel-v-provider-smoke-run-31957535685-1-abcdef1234567890',
      tags: {
        provider: 'vercel',
        repository: repositoryTag,
        branch: 'fixture-existing-abcdef12345678',
        version: 'v-provider-smoke-run-31957535685-1-abcdef1234567890',
        identity: 'abcdef1234567890',
      },
      status: 'stopped',
    };
    const { owned, ignored } = selectSmokeOwnedSandboxes([
      valid,
      { ...valid, tags: { ...valid.tags, provider: 'local' } },
      { ...valid, tags: { ...valid.tags, repository: 'github-com-other-repo-abcdef1234567890' } },
      { ...valid, tags: { ...valid.tags, extra: 'must-reject' } },
      { ...valid, tags: { ...valid.tags, identity: '1111111111111111' } },
      { ...valid, name: 'devbox-vercel-v-0-1-2-github-com-acme-private-fixture-main-abcdef12345678' },
    ], repositoryTag);

    expect(owned).toEqual([valid]);
    expect(ignored.map((sandbox) => sandbox.name)).toEqual([
      valid.name,
      valid.name,
      valid.name,
      valid.name,
    ]);
  });

  it('requires exact current-path names before recovery cleanup', () => {
    expect(isExactSmokeSandboxRecord({ name: 'owned-sandbox' }, 'owned-sandbox')).toBe(true);
    expect(isExactSmokeSandboxRecord({ name: 'owned-sandbox-decoy' }, 'owned-sandbox')).toBe(false);
  });

  it('accepts sandboxMissing proof only when the authoritative final relist is absent', () => {
    const cleanupResult = {
      verified: true,
      sandboxMissing: true,
      errors: [],
      finalSessions: [],
    };
    expect(hasPreflightSandboxProof({
      cleanupResult,
      expectedName: 'owned-sandbox',
      finalListingSucceeded: true,
      finalRecords: [],
      sessionProof: false,
    })).toBe(true);
    expect(hasPreflightSandboxProof({
      cleanupResult,
      expectedName: 'owned-sandbox',
      finalListingSucceeded: true,
      finalRecords: [{ name: 'owned-sandbox' }],
      sessionProof: false,
    })).toBe(false);
  });

  it('budgets both sequential smoke paths plus per-path cleanup inside the outer deadline', () => {
    expect(calculateVercelProviderSmokeBudget('both', 100, 20, 5, 10)).toEqual({
      pathCount: 2,
      pathTimeoutMs: 100,
      cleanupTimeoutMs: 20,
      fixtureTimeoutMs: 5,
      pathProbeTimeoutMs: 10,
      preflightTimeoutMs: 20,
      outerTimeoutMs: 365,
    });
    expect(calculateVercelProviderSmokeBudget('existing', 100, 20, 5, 10).outerTimeoutMs).toBe(195);
    expect(calculateVercelProviderSmokeBudget('both', 720_000, 120_000, 30_000, 10_000).outerTimeoutMs)
      .toBe(2_330_000);
  });

  it('rejects a non-positive smoke budget', () => {
    expect(() => calculateVercelProviderSmokeBudget('both', 0, 20, 5, 10)).toThrow(/positive/i);
    expect(() => calculateVercelProviderSmokeBudget('both', 100, -1, 5, 10)).toThrow(/positive|non-negative/i);
    expect(() => calculateVercelProviderSmokeBudget('both', 100, 20, 5, 0)).toThrow(/positive/i);
  });

  it('requires the complete Vercel credential triad before a smoke can run', () => {
    expect(() => parseVercelProviderSmokeConfig(environment({ VERCEL_PROJECT_ID: undefined })))
      .toThrow(/VERCEL_PROJECT_ID.*required|complete.*triad/i);
  });

  it('preserves multiline expected fixture content without treating it as a credential', () => {
    const expectedContent = ['first line', 'second line', ''].join('\n');
    const config = parseVercelProviderSmokeConfig(environment({ DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT: expectedContent }));
    expect(config.fixture.expectedContent).toBe(expectedContent);
  });

  it('keeps Vercel and GitHub credentials as separate in-memory fields', () => {
    const config = parseVercelProviderSmokeConfig(environment());
    expect(config.credentials.token).toBe('vercel-token');
    expect(config.fixture.token).toBe('github-token');
    expect(config.fixture.repository).toBe('acme/private-fixture');
    expect(config.path).toBe('both');
  });

  it('rejects fixture values that could escape the cloned repository', () => {
    expect(() => parseVercelProviderSmokeConfig(environment({ DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE: '../secret.txt' })))
      .toThrow(/relative|parent/i);
    expect(() => parseVercelProviderSmokeConfig(environment({ DEVBOX_GITHUB_FIXTURE_REPOSITORY: 'https://github.com/acme/private-fixture.git' })))
      .toThrow(/owner\/repository/i);
  });

  it('accepts the checked-in promoted image pin before credential validation', () => {
    expect(assertPromotedVercelImagePin(VERCEL_IMAGE_PIN)).toMatchObject({
      registry: 'vcr.vercel.com',
      team: 'astro-labs',
      project: 'devbox',
      repository: 'devbox',
      digest: 'sha256:a4aa03890d74f5251f3861c4f6e96afeab3d0b7881b8206fa0de4223bdf051f7',
    });
  });

  it('uses production Sandbox and terminal adapters with bounded cleanup evidence', async () => {
    const source = await readFile('scripts/vercel/provider-smoke.mjs', 'utf8');
    const terminalSource = await readFile('scripts/vercel/smoke-terminal.mjs', 'utf8');
    for (const required of [
      "from '@vercel/sandbox'",
      'buildVercelSandboxCreateRequest',
      'createVercelSandboxClient',
      'createVercelTerminalAdapter',
      'runInteractiveTerminal',
      'validateCloneBranchState',
      'resolveVercelRepositoryCwd',
      'resume: true',
      "git', ['remote', 'get-url', 'origin']",
      "git', ['rev-parse', 'HEAD']",
      "cat', ['--', config.fixture.expectedFile]",
      'cleanupVercelSandbox',
      'recoverOwnedResources',
      'deleteListedSnapshot',
      'SMOKE_TOTAL_TIMEOUT_MS',
      'finally',
    ]) {
      expect(source).toContain(required);
    }
    for (const required of [
      'terminalAdapter.attach',
      'openInteractive',
      "signalSource.emit('SIGINT')",
      'provider-smoke-interrupted-',
      'encodedReadyMarker',
      'encodedSleepMarker',
      'waitForOutput(stdout, interruptMarker',
      'base64 -d',
      'outputBeforeInterrupt',
      'postInterruptMarker',
      'Buffer.from([0x1d])',
      "reason === 'escape'",
    ]) {
      expect(terminalSource).toContain(required);
    }
    expect(terminalSource).not.toContain('exit\\n');
    expect(source).not.toContain('sandbox.openInteractive');
    expect(source).not.toContain('execFile');
    expect(source).not.toContain('process.argv');
    expect(source.indexOf('const image = assertPromotedVercelImagePin'))
      .toBeLessThan(source.indexOf('initializeSecretValues();'));
    expect(source).not.toContain('vercel sandbox');
    expect(source).toContain("'private clone requested revision HEAD'");
    expect(source).toContain("'private clone existing revision branch state'");
    expect(source).toContain('allowDetachedBranch: requestedBranchExists');
  });

  it('directly reconciles known path sandboxes before collection recovery and preflights stale runs', async () => {
    const source = await readFile('scripts/vercel/provider-smoke.mjs', 'utf8');
    const runPath = source.slice(source.indexOf('async function runPath'));
    const finallyBlock = runPath.slice(runPath.indexOf('} finally {'));
    expect(source).toContain('preflightSmokeResources');
    expect(source).toContain("'preflight-cleanup'");
    expect(source).toContain('report.preflight');
    expect(finallyBlock).toContain('combineSignals(runSignal, cleanupController.signal)');
    expect(finallyBlock.indexOf('cleanupVercelSandbox')).toBeGreaterThanOrEqual(0);
    expect(finallyBlock.indexOf('recoverOwned')).toBeGreaterThan(finallyBlock.indexOf('cleanupVercelSandbox'));
    expect(source).toContain('SMOKE_NAME_PREFIX');
    expect(source).toContain('selectSmokeOwnedSandboxes');
    expect(source).toContain('if (!sandbox || sandbox.name !== identity.name)');
  });

  it('uses valid GitHub fixture secret names in both workflow interfaces', async () => {
    const caller = await readFile('.github/workflows/ci.yml', 'utf8');
    const callee = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    for (const workflow of [caller, callee]) {
      expect(workflow).not.toMatch(/secrets\.GITHUB_/);
      for (const name of VALID_FIXTURE_SECRET_NAMES) expect(workflow).toContain(name);
    }
    for (const name of VALID_FIXTURE_SECRET_NAMES) {
      expect(caller).toContain(`${name}: \${{ secrets.${name} }}`);
      expect(callee).toMatch(new RegExp(`${name}:[\\s\\S]*?required: true`));
    }
  });

  it('defines a reusable exact-source smoke contract with explicit private secrets', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    expect(workflow).toContain('workflow_call:');
    expect(workflow).toMatch(/source_sha:[\s\S]*?required: true[\s\S]*?type: string/);
    expect(workflow).toMatch(/path:[\s\S]*?required: true[\s\S]*?type: string/);
    for (const secret of PROVIDER_SMOKE_SECRETS) {
      expect(workflow).toMatch(new RegExp(`${secret}:[\\s\\S]*?required: true`));
    }
    // The generic VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID names are the
    // script environment contract only; they must never appear as secrets.
    expect(workflow).not.toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(workflow).not.toContain('VERCEL_TEAM_ID: ${{ secrets.VERCEL_TEAM_ID }}');
    expect(workflow).not.toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}');
  });

  it('defends reusable calls with trusted events and an exact full source SHA', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    const providerJob = workflow.slice(workflow.indexOf('  provider-smoke:'));
    expect(providerJob).not.toMatch(/\n\s{4}if:/);
    expect(workflow).toContain('SOURCE_SHA: ${{ inputs.source_sha || github.sha }}');
    expect(workflow).toContain('[[ "${SOURCE_SHA}" =~ ^[a-f0-9]{40}$ ]]');
    expect(workflow).toContain('GITHUB_EVENT_NAME');
    expect(workflow).toContain('pull_request)');
    expect(workflow).toContain("github.event.action");
    expect(workflow).toContain("github.actor");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name");
    expect(workflow).toContain('psmoke:${SOURCE_SHA}');
    expect(workflow).toContain('github.event.pull_request.head.sha');
    expect(workflow).toContain('GITHUB_REF_NAME');
    expect(workflow).toContain('github.event.repository.default_branch');
    expect(workflow).not.toContain('pull_request_target');
  });

  it('authorizes smoke with a GitHub-label-safe exact lowercase SHA label', async () => {
    const sha = 'a'.repeat(40);
    const label = `psmoke:${sha}`;
    // GitHub label names are limited to 50 characters; psmoke: + 40 hex is 47.
    expect(label.length).toBeLessThanOrEqual(50);
    expect(label).toMatch(/^psmoke:[a-f0-9]{40}$/);
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    // The caller formats the label from the exact PR head SHA and the callee
    // repeats the comparison against the guard-validated full lowercase SHA.
    const ci = await loadWorkflow('.github/workflows/ci.yml');
    const callerJob = (ci.jobs as Record<string, Record<string, unknown>>)['vercel-provider-smoke'];
    expect(String(callerJob.if)).toContain("format('psmoke:{0}', github.event.pull_request.head.sha)");
    const callee = await loadWorkflow('.github/workflows/vercel-provider-smoke.yml');
    const job = (callee.jobs as Record<string, { steps: Array<Record<string, unknown>> }>)['provider-smoke'];
    const guardRun = String(job.steps.find((s) => s.id === 'guard')?.run ?? '');
    expect(guardRun).toContain('[[ "${SOURCE_SHA}" =~ ^[a-f0-9]{40}$ ]]');
    expect(guardRun).toContain('test "${EXPECTED_HEAD_SHA}" = "${SOURCE_SHA}"');
    expect(guardRun).toContain('test "${EXPECTED_LABEL_NAME}" = "psmoke:${SOURCE_SHA}"');
  });

  it('structurally maps the caller gate inputs to explicit read-only secrets', async () => {
    const ci = await loadWorkflow('.github/workflows/ci.yml');
    const on = ci.on as Record<string, { types?: string[] }>;
    expect(on.pull_request?.types).toContain('labeled');
    const jobs = ci.jobs as Record<string, Record<string, unknown>>;
    const caller = jobs['vercel-provider-smoke'];
    expect(caller).toBeDefined();
    expect(String(caller.if)).toContain("format('psmoke:{0}', github.event.pull_request.head.sha)");
    expect(caller.uses).toBe('./.github/workflows/vercel-provider-smoke.yml');
    expect((caller.permissions as Record<string, string>).contents).toBe('read');
    const withInputs = caller.with as Record<string, string>;
    expect(withInputs.source_sha).toBe('${{ github.event.pull_request.head.sha }}');
    expect(withInputs.path).toBe('both');
    const secrets = caller.secrets as Record<string, string>;
    for (const name of PROVIDER_SMOKE_SECRETS) {
      expect(secrets[name]).toBe('${{ secrets.' + name + ' }}');
    }
    expect(Object.keys(secrets).sort()).toEqual([...PROVIDER_SMOKE_SECRETS].sort());
    expect(caller.secrets).not.toBe('inherit');
    // The caller must source the Vercel triad from the consumer secrets; the
    // generic secret names are absent from the repository.
    const ciText = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(ciText).not.toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(ciText).not.toContain('VERCEL_TEAM_ID: ${{ secrets.VERCEL_TEAM_ID }}');
    expect(ciText).not.toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}');
  });

  it('structurally parses the called workflow inputs, secrets, and evidence env contract', async () => {
    const workflow = await loadWorkflow('.github/workflows/vercel-provider-smoke.yml');
    const on = workflow.on as Record<string, Record<string, unknown>>;
    const call = on.workflow_call as Record<string, Record<string, unknown>>;
    const inputs = call.inputs as Record<string, Record<string, unknown>>;
    expect(inputs.source_sha).toMatchObject({ required: true, type: 'string' });
    expect(inputs.path).toMatchObject({ required: true, type: 'string' });
    const secrets = call.secrets as Record<string, Record<string, unknown>>;
    for (const name of PROVIDER_SMOKE_SECRETS) {
      expect(secrets[name]).toMatchObject({ required: true });
    }
    expect(Object.keys(secrets).sort()).toEqual([...PROVIDER_SMOKE_SECRETS].sort());
    const dispatch = on.workflow_dispatch as Record<string, Record<string, unknown>>;
    const dispatchPath = dispatch.inputs as Record<string, Record<string, unknown>>;
    expect((dispatchPath.path as Record<string, unknown>).type).toBe('choice');
    expect(dispatchPath.path.options).toEqual(['both', 'existing', 'missing']);
    const job = (workflow.jobs as Record<string, Record<string, unknown>>)['provider-smoke'];
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect((job.environment as Record<string, string>).name).toBe('vercel-provider-smoke');
    expect((job.permissions as Record<string, string>).contents).toBe('read');
    // runner.temp is unavailable at job level; the evidence directory is
    // established from $RUNNER_TEMP via GITHUB_ENV after checkout.
    expect(JSON.stringify(job.env)).not.toContain('runner.temp');
    const steps = job.steps as Array<Record<string, unknown>>;
    expect((steps[0] as Record<string, unknown>).id).toBe('guard');
    expect(JSON.stringify((steps[0] as Record<string, unknown>).env)).not.toContain('${{ secrets.');
    const smokeStep = steps.find((s) => s.name === 'Run real provider smoke') as Record<string, unknown>;
    const smokeEnv = smokeStep.env as Record<string, string>;
    for (const secret of PROVIDER_SMOKE_SECRETS) {
      expect(smokeEnv[PROVIDER_SMOKE_SECRET_TO_ENV[secret]]).toBe('${{ secrets.' + secret + ' }}');
    }
    expect(smokeEnv.SMOKE_REPORT).toBe('${{ env.ARTIFACT_DIR }}/provider-smoke.json');
    const upload = steps.find((s) => s.name === 'Upload redacted provider smoke evidence') as Record<string, unknown>;
    expect((upload.with as Record<string, string>).path).toBe('${{ env.ARTIFACT_DIR }}');
  });

  it('checks out, records, and uploads the exact authorized source identity', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    expect(workflow).toContain('ref: ${{ env.SOURCE_SHA }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('git rev-parse HEAD');
    expect(workflow).toContain('sourceSha');
    expect(workflow).toContain('vercel-provider-smoke-${{ env.SOURCE_SHA }}-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflow).not.toContain('ref: ${{ github.ref }}');
    expect(workflow).not.toContain('ref: ${{ github.ref_name }}');
  });

  it('gates the manual workflow and uploads only redacted evidence', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('type: choice');
    for (const path of ['both', 'existing', 'missing']) expect(workflow).toContain(`- ${path}`);
    expect(workflow).toContain('src/providers/vercel/image.ts');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain("github.actor == github.repository_owner");
    expect(workflow).toContain('test "${GITHUB_REF_NAME}" = "${EXPECTED_DEFAULT_BRANCH}"');
    expect(workflow).toContain('test "${EXPECTED_REPOSITORY_FORK}" = \'false\'');
    expect(workflow).toContain('environment:\n      name: vercel-provider-smoke');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('timeout-minutes: 45');
    expect(workflow).toContain("SMOKE_TOTAL_TIMEOUT_MS: '2400000'");
    expect(workflow).toContain('id: guard');
    expect(workflow).toContain("if: always() && steps.guard.outcome == 'success'");
    expect(workflow).toContain('redacted":false');
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('scripts/vercel/redact-artifacts.mjs');
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    for (const line of workflow.split('\n').filter((value) => value.trim().startsWith('uses: '))) {
      expect(line).toMatch(/uses: [^@]+@[a-f0-9]{40}(?:\s+#.*)?$/);
    }
    for (const secret of PROVIDER_SMOKE_SECRETS) {
      expect(workflow).toContain(PROVIDER_SMOKE_SECRET_TO_ENV[secret] + ': ${{ secrets.' + secret + ' }}');
    }
  });

  it('keeps credentials out of authorization and evidence material', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    const beforeSmoke = workflow.match(/steps:[\s\S]*?(?=\n\s{6}- name: Run real provider smoke)/)?.[0] ?? '';
    expect(beforeSmoke).not.toContain('${{ secrets.');
    expect(workflow).not.toContain('toJSON(secrets)');
    expect(workflow).not.toMatch(/SMOKE_REPORT:\s*\$\{\{\s*secrets\./);
    expect(workflow).toContain('scripts/vercel/redact-artifacts.mjs');
    expect(workflow).toContain('redacted":false');
  });

  it('keeps secret-bearing smoke steps behind the trusted guard after pin validation', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    const smokeStep = workflow.match(/- name: Run real provider smoke[\s\S]*?(?=\n\s{6}- name:)/)?.[0] ?? '';
    const redactStep = workflow.match(/- name: Redact all provider smoke evidence[\s\S]*?(?=\n\s{6}- name:)/)?.[0] ?? '';
    expect(workflow).toContain('id: pin');
    expect(workflow).toContain('Validate promoted image pin before credentials');
    expect(workflow).toContain('configuration; it uses no Vercel CLI or GitHub CLI.');
    expect(smokeStep).toContain("if: success() && steps.guard.outcome == 'success'");
    expect(smokeStep).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_CONSUMER_TOKEN }}');
    expect(smokeStep).toContain('VERCEL_TEAM_ID: ${{ secrets.VERCEL_CONSUMER_TEAM_ID }}');
    expect(smokeStep).toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_CONSUMER_PROJECT_ID }}');
    expect(smokeStep).not.toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(redactStep).toContain("if: always() && steps.guard.outcome == 'success'");
    expect(redactStep).toContain('DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT: ${{ secrets.DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT }}');
    expect(smokeStep).not.toContain('steps.pin.outcome');
  });

  it('runs provider quality on the supported Node 22 LTS lane', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    const smoke = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    const release = await readFile('.github/workflows/release.yml', 'utf8');
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe('>=22');
    expect(ci).toContain("name: quality and provider contracts (Node 22)");
    expect(ci).toContain("node-version: '22'");
    expect(ci).not.toContain('matrix.node-version');
    expect(ci).toContain('npm run lint');
    expect(ci).toContain('npm run typecheck');
    expect(ci).toContain('npm run build');
    expect(ci).toContain('npm run test');
    expect(smoke).toContain("node-version: '22'");
    expect(smoke).not.toContain("node-version: '20.18.1'");
    expect(release).toContain("node-version: '22'");
    expect(release).not.toMatch(/node-version:\s*'20'/);
  });

  it('keeps smoke configuration internal to the provider implementation', async () => {
    const providerBarrel = await readFile('src/providers/vercel/index.ts', 'utf8');
    const publicBarrel = await readFile('src/providers/index.ts', 'utf8');
    expect(providerBarrel).not.toContain("./smoke-config.js");
    expect(publicBarrel).not.toContain("./vercel/smoke-config.js");
  });

  it('lists the exact secret-backed fixture configuration fields', () => {
    expect(REQUIRED_VERCEL_PROVIDER_SMOKE_ENV).toEqual([
      'VERCEL_TOKEN',
      'VERCEL_TEAM_ID',
      'VERCEL_PROJECT_ID',
      'DEVBOX_GITHUB_FIXTURE_TOKEN',
      'DEVBOX_GITHUB_FIXTURE_REPOSITORY',
      'DEVBOX_GITHUB_FIXTURE_BRANCH',
      'DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH',
      'DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE',
      'DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT',
      'SMOKE_REPORT',
    ]);
  });

  it('requires explicit UAT contract markers for the private fixture path', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-uat.yml', 'utf8');
    const source = await readFile('scripts/vercel/provider-smoke.mjs', 'utf8');

    expect(workflow).toContain("DEVBOX_UAT_REQUIRED: 'true'");
    for (const marker of [
      'DEVBOX_UAT:agents',
      'DEVBOX_UAT:chromium-oauth',
      'DEVBOX_UAT:electron-vite',
      'DEVBOX_UAT:push',
      'DEVBOX_UAT:resume-secret-refresh',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('provider UAT requires non-empty fixture and resume contract commands');
    expect(source).toContain('provider UAT requires both existing and missing private-repository paths');
    expect(source).toContain('uatFixtureCommand && label === \'missing\'');
    expect(source).toContain('uatResumeCommand && label === \'missing\'');
  });
});
