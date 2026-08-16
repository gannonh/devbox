import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { VERCEL_IMAGE_PIN } from '../src/providers/vercel/image.js';
import {
  assertPromotedVercelImagePin,
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

  it('rejects the checked-in zero image pin before any provider API call', () => {
    expect(() => assertPromotedVercelImagePin(VERCEL_IMAGE_PIN))
      .toThrow(/blocked.*unpromoted|uninitialized/i);
  });

  it('uses production Sandbox and terminal adapters with bounded cleanup evidence', async () => {
    const source = await readFile('scripts/vercel/provider-smoke.mjs', 'utf8');
    for (const required of [
      "from '@vercel/sandbox'",
      'buildVercelSandboxCreateRequest',
      'createVercelSandboxClient',
      'createVercelTerminalAdapter',
      'openInteractive',
      "signalSource.emit('SIGINT')",
      'provider-smoke-interrupted-',
      'encodedReadyMarker',
      'encodedSleepMarker',
      'waitForOutput(stdout, interruptMarker',
      'base64 -d',
      'outputBeforeInterrupt',
      'let secretValues = []',
      'initializeSecretValues()',
      'resume: true',
      "git', ['remote', 'get-url', 'origin']",
      "git', ['rev-parse', 'HEAD']",
      "cat', ['--', config.fixture.expectedFile]",
      'cleanupVercelSandbox',
      'recoverOwnedResources',
      'deleteListedSnapshot',
      'finally',
    ]) {
      expect(source).toContain(required);
    }
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
    expect(workflow).toContain("github.actor == github.repository_owner");
    expect(workflow).toContain('github.ref_name == github.event.repository.default_branch');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('timeout-minutes: 30');
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

  it('runs quality and provider contracts at the support floor and current Node release', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain("node-version: ['20.18.1', '24']");
    expect(ci).toContain('Provider import and auth-routing contracts');
    expect(ci).toContain('tests/provider-registry.test.ts');
    expect(ci).toContain('tests/cli-provider-routing.test.ts');
    expect(ci).toContain('tests/vercel-auth.test.ts');
    expect(ci).toContain("if: matrix.node-version == '20.18.1'");
    expect(ci).toContain('npm run test');
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
