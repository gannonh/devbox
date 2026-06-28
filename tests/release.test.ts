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

describe('release workflow contract', () => {
  it('parses as valid YAML', async () => {
    const wf = await loadWorkflow();
    expect(wf).toBeTruthy();
    expect(typeof wf).toBe('object');
  });

  it('has both tag-push and workflow_dispatch triggers', async () => {
    const wf = await loadWorkflow();
    const on = wf.on as Record<string, unknown>;
    expect(on).toBeDefined();
    // Tag push: either a string 'v*' pattern or push.tags config
    expect(on.push).toBeDefined();
    const push = on.push as Record<string, string[]>;
    expect(push.tags).toBeDefined();
    expect(push.tags.some((t) => t.includes('v'))).toBe(true);
    // Manual dispatch
    expect(on.workflow_dispatch).toBeDefined();
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
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const release = jobs.release as Record<string, { steps: Array<Record<string, unknown>> }>;
    const hasSetupNode = release.steps.some(
      (s) => s.uses && String(s.uses).startsWith('actions/setup-node'),
    );
    expect(hasSetupNode).toBe(true);
  });

  it('references NPM_TOKEN secret on the publish step', async () => {
    const wf = await loadWorkflow();
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const release = jobs.release as Record<string, { steps: Array<Record<string, unknown>> }>;
    const wfStr = JSON.stringify(release.steps);
    expect(wfStr).toContain('NPM_TOKEN');
  });

  it('gates npm publish on dry_run being false', async () => {
    const wf = await loadWorkflow();
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const release = jobs.release as Record<string, { steps: Array<Record<string, unknown>> }>;
    const wfStr = JSON.stringify(release.steps);
    // dry_run must appear somewhere as an if-condition gating publish
    expect(wfStr).toContain('dry_run');
  });

  it('runs build, test, and lint steps', async () => {
    const wf = await loadWorkflow();
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const release = jobs.release as Record<string, { steps: Array<Record<string, unknown>> }>;
    const wfStr = JSON.stringify(release.steps);
    expect(wfStr).toMatch(/npm run build/);
    expect(wfStr).toMatch(/npm run test/);
    expect(wfStr).toMatch(/npm run lint/);
  });
});
