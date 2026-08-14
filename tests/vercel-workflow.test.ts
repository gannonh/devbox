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
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain("cron:");
    expect(workflow).toContain('gh pr create');
    expect(workflow).not.toContain('gh pr merge');
    expect(workflow).not.toContain('enable-auto-merge');
  });

  it('builds an amd64 zstd immutable candidate and waits for readiness', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('docker/setup-buildx-action');
    expect(workflow).toContain('--platform linux/amd64');
    expect(workflow).toContain('compression=zstd');
    expect(workflow).toContain('sha-${GITHUB_SHA}');
    expect(workflow).toContain('wait-vcr-ready.mjs');
    expect(workflow).toContain('Preparing');
    expect(workflow).toContain('Unoptimized');
    expect(workflow).toContain('image_not_ready');
  });

  it('uses separate publisher and consumer credentials and both exact-digest smoke gates', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('VERCEL_PUBLISHER_TOKEN');
    expect(workflow).toContain('VERCEL_CONSUMER_TOKEN');
    expect(workflow).toContain('VERCEL_PUBLISHER_PROJECT_ID');
    expect(workflow).toContain('VERCEL_CONSUMER_PROJECT_ID');
    expect(workflow).toContain('smoke-sandbox.mjs');
    expect(workflow).toContain('SMOKE_ROLE: publisher');
    expect(workflow).toContain('SMOKE_ROLE: consumer');
    expect(workflow).toContain('EXPECTED_IMAGE_DIGEST');
    expect(workflow).toContain('snapshot');
    expect(workflow).toContain('deleted');
  });

  it('redacts workflow evidence and promotes only after both smoke gates', async () => {
    const workflow = await workflowText();
    expect(workflow).toContain('redact-artifacts.mjs');
    expect(workflow).toContain('promote-image.mjs');
    expect(workflow).toContain('cross-project');
    expect(workflow).toMatch(/if: \$\{\{ success\(\)/);
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('pull-requests: write');
  });

  it('ships the workflow helper scripts', async () => {
    await Promise.all([
      exists('scripts/vercel/resolve-universal-digest.mjs'),
      exists('scripts/vercel/wait-vcr-ready.mjs'),
      exists('scripts/vercel/smoke-sandbox.mjs'),
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
