import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
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
    GITHUB_FIXTURE_TOKEN: 'github-token',
    GITHUB_FIXTURE_REPOSITORY: 'acme/private-fixture',
    GITHUB_FIXTURE_BRANCH: 'fixture-existing',
    GITHUB_FIXTURE_DEFAULT_BRANCH: 'main',
    GITHUB_FIXTURE_EXPECTED_FILE: 'fixture.txt',
    GITHUB_FIXTURE_EXPECTED_CONTENT: 'private fixture content',
    SMOKE_PATH: 'both',
    SMOKE_REPORT: '/tmp/provider-smoke.json',
    ...overrides,
  };
}

describe('Vercel provider smoke configuration', () => {
  it('budgets both sequential smoke paths plus per-path cleanup inside the outer deadline', () => {
    expect(calculateVercelProviderSmokeBudget('both', 100, 20, 5, 10)).toEqual({
      pathCount: 2,
      pathTimeoutMs: 100,
      cleanupTimeoutMs: 20,
      fixtureTimeoutMs: 5,
      pathProbeTimeoutMs: 10,
      outerTimeoutMs: 265,
    });
    expect(calculateVercelProviderSmokeBudget('existing', 100, 20, 5, 10).outerTimeoutMs).toBe(135);
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
    const config = parseVercelProviderSmokeConfig(environment({ GITHUB_FIXTURE_EXPECTED_CONTENT: expectedContent }));
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
    expect(() => parseVercelProviderSmokeConfig(environment({ GITHUB_FIXTURE_EXPECTED_FILE: '../secret.txt' })))
      .toThrow(/relative|parent/i);
    expect(() => parseVercelProviderSmokeConfig(environment({ GITHUB_FIXTURE_REPOSITORY: 'https://github.com/acme/private-fixture.git' })))
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
    ]) {
      expect(terminalSource).toContain(required);
    }
    expect(source).not.toContain('sandbox.openInteractive');
    expect(source).not.toContain('execFile');
    expect(source).not.toContain('process.argv');
    expect(source.indexOf('const image = assertPromotedVercelImagePin'))
      .toBeLessThan(source.indexOf('initializeSecretValues();'));
    expect(source).not.toContain('vercel sandbox');
  });

  it('gates the manual workflow and uploads only redacted evidence', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('src/providers/vercel/image.ts');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain("github.actor == github.repository_owner");
    expect(workflow).toContain('github.ref_name == github.event.repository.default_branch');
    expect(workflow).toContain('github.event.repository.fork == false');
    expect(workflow).toContain('environment:\n      name: vercel-provider-smoke');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('timeout-minutes: 35');
    expect(workflow).toContain("SMOKE_TOTAL_TIMEOUT_MS: '1760000'");
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
    for (const name of REQUIRED_VERCEL_PROVIDER_SMOKE_ENV.filter((value) => value !== 'SMOKE_REPORT')) {
      expect(workflow).toContain(name + ': ${{ secrets.' + name + ' }}');
    }
  });

  it('keeps secret-bearing smoke steps behind the trusted guard after pin validation', async () => {
    const workflow = await readFile('.github/workflows/vercel-provider-smoke.yml', 'utf8');
    const smokeStep = workflow.match(/- name: Run real provider smoke[\s\S]*?(?=\n {6}- name:)/)?.[0] ?? '';
    const redactStep = workflow.match(/- name: Redact all provider smoke evidence[\s\S]*?(?=\n {6}- name:)/)?.[0] ?? '';
    expect(workflow).toContain('id: pin');
    expect(workflow).toContain('Validate promoted image pin before credentials');
    expect(workflow).toContain('configuration; it uses no Vercel CLI or GitHub CLI.');
    expect(smokeStep).toContain("if: always() && steps.guard.outcome == 'success'");
    expect(smokeStep).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(redactStep).toContain("if: always() && steps.guard.outcome == 'success'");
    expect(redactStep).toContain('GITHUB_FIXTURE_EXPECTED_CONTENT: ${{ secrets.GITHUB_FIXTURE_EXPECTED_CONTENT }}');
    expect(smokeStep).not.toContain('steps.pin.outcome');
  });

  it('runs quality and provider contracts at the support floor and current Node release', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain("node-version: ['20.18.1', '24']");
    expect(ci).toContain('Provider and smoke workflow contracts');
    expect(ci).toContain('tests/provider-registry.test.ts');
    expect(ci).toContain('tests/cli-provider-routing.test.ts');
    expect(ci).toContain('tests/vercel-auth.test.ts');
    expect(ci).toContain('tests/vercel-provider-smoke.test.ts');
    expect(ci).toContain('tests/vercel-smoke-evidence.test.ts');
    expect(ci).toContain('tests/vercel-smoke-terminal.test.ts');
    expect(ci).toContain('tests/vercel-workflow.test.ts');
    expect(ci).toContain("if: matrix.node-version == '24'");
    expect(ci).toContain("if: matrix.node-version == '20.18.1'");
    expect(ci).toContain('npm run test');
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
      'GITHUB_FIXTURE_TOKEN',
      'GITHUB_FIXTURE_REPOSITORY',
      'GITHUB_FIXTURE_BRANCH',
      'GITHUB_FIXTURE_DEFAULT_BRANCH',
      'GITHUB_FIXTURE_EXPECTED_FILE',
      'GITHUB_FIXTURE_EXPECTED_CONTENT',
      'SMOKE_REPORT',
    ]);
  });
});
