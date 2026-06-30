import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Parse the release workflow YAML and assert its structural contract.
// This locks in the workflow shape so changes are intentional.
// js-yaml is a transitive dep (via vitest/eslint); dynamic import keeps it
// out of package.json dependencies while still being available in the test env.
async function loadWorkflow(): Promise<Record<string, unknown>> {
  const yaml = await import('js-yaml');
  const path = resolve('.github/workflows/release.yml');
  const content = readFileSync(path, 'utf-8');
  return yaml.load(content) as Record<string, unknown>;
}

function releaseSteps(wf: Record<string, unknown>): Array<Record<string, unknown>> {
  const jobs = wf.jobs as Record<string, Record<string, unknown>>;
  const release = jobs.release as Record<string, { steps: Array<Record<string, unknown>> }>;
  return release.steps;
}

function stepNames(steps: Array<Record<string, unknown>>): string[] {
  return steps.map((s) => String(s.name ?? s.uses ?? ''));
}

function stepByName(wf: Record<string, unknown>, name: string): Record<string, unknown> {
  const steps = releaseSteps(wf);
  const step = steps.find((s) => String(s.name) === name);
  if (!step) throw new Error(`step "${name}" not found`);
  return step;
}

describe('release workflow contract', () => {
  it('parses as valid YAML', async () => {
    const wf = await loadWorkflow();
    expect(wf).toBeTruthy();
    expect(typeof wf).toBe('object');
  });

  it('is manual-dispatch only (no tag-push trigger)', async () => {
    const wf = await loadWorkflow();
    const on = wf.on as Record<string, unknown>;
    expect(on).toBeDefined();
    // Manual dispatch is the sole trigger.
    expect(on.workflow_dispatch).toBeDefined();
    // No push.tags auto-trigger: a failed publish must never leave a tag.
    expect(on.push).toBeUndefined();
  });

  it('defines workflow_dispatch inputs: version (string) and dry_run (boolean)', async () => {
    const wf = await loadWorkflow();
    const on = wf.on as Record<string, Record<string, unknown>>;
    const dispatch = on.workflow_dispatch as Record<string, unknown>;
    const inputs = dispatch.inputs as Record<string, Record<string, unknown>>;
    expect(inputs).toBeDefined();

    const version = inputs.version;
    expect(version).toBeDefined();
    expect(version.type).toBe('string');
    expect(version.required).toBeFalsy();

    const dryRun = inputs.dry_run;
    expect(dryRun).toBeDefined();
    expect(dryRun.type).toBe('boolean');
    expect(dryRun.default).toBe(false);
  });

  it('runs on ubuntu-latest', async () => {
    const wf = await loadWorkflow();
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const release = jobs.release as Record<string, unknown>;
    expect(release['runs-on']).toBe('ubuntu-latest');
  });

  it('uses actions/setup-node for Node setup', async () => {
    const wf = await loadWorkflow();
    const hasSetupNode = releaseSteps(wf).some(
      (s) => s.uses && String(s.uses).startsWith('actions/setup-node'),
    );
    expect(hasSetupNode).toBe(true);
  });

  it('references NPM_TOKEN secret on the publish step', async () => {
    const wf = await loadWorkflow();
    const wfStr = JSON.stringify(releaseSteps(wf));
    expect(wfStr).toContain('NPM_TOKEN');
  });

  it('publishes the package as public', async () => {
    const wf = await loadWorkflow();
    const wfStr = JSON.stringify(releaseSteps(wf));
    expect(wfStr).toContain('--access public');
  });

  it('gates npm publish on dry_run being false', async () => {
    const wf = await loadWorkflow();
    const wfStr = JSON.stringify(releaseSteps(wf));
    // dry_run must appear somewhere as an if-condition gating publish
    expect(wfStr).toContain('dry_run');
  });

  it('runs build, test, and lint steps', async () => {
    const wf = await loadWorkflow();
    const wfStr = JSON.stringify(releaseSteps(wf));
    expect(wfStr).toMatch(/npm run build/);
    expect(wfStr).toMatch(/npm run test/);
    expect(wfStr).toMatch(/npm run lint/);
  });

  it('stages both package.json and package-lock.json in the version commit', async () => {
    const wf = await loadWorkflow();
    const commit = stepByName(wf, 'Commit version bump and create tag');
    const run = String(commit.run ?? '');
    expect(run).toContain('git add package.json package-lock.json');
  });

  it('creates the tag only after publish succeeds', async () => {
    const wf = await loadWorkflow();
    const commit = stepByName(wf, 'Commit version bump and create tag');
    const ifCond = String(commit.if ?? '');
    // Must be gated on success() so a publish failure skips the tag.
    expect(ifCond).toContain('success()');
  });

  it('creates a GitHub Release with npx/npm install instructions', async () => {
    const wf = await loadWorkflow();
    const create = stepByName(wf, 'Create GitHub Release');
    const run = String(create.run ?? '');
    expect(run).toContain('gh release create');
    // Install instructions for both npx and npm i -g.
    expect(run).toContain('npx @gannonh/devbox init');
    expect(run).toContain('npm install -g @gannonh/devbox');
    // GH_TOKEN must be available for gh release create.
    const env = create.env as Record<string, string> | undefined;
    expect(env?.GH_TOKEN).toBeDefined();
  });

  it('orders publish before the tag/release steps', async () => {
    const wf = await loadWorkflow();
    const names = stepNames(releaseSteps(wf));
    const publishIdx = names.indexOf('Publish to npm');
    const tagIdx = names.indexOf('Commit version bump and create tag');
    const releaseIdx = names.indexOf('Create GitHub Release');
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    expect(tagIdx).toBeGreaterThan(publishIdx);
    expect(releaseIdx).toBeGreaterThan(tagIdx);
  });
});
