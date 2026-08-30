import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createWorkflowRunEligibility,
  loadCleanupDependencies,
  selectRunTaggedSandboxes,
  waitForEmptyResourceInventory,
} from '../scripts/vercel/session-uat-cleanup.mjs';
import { createEvidence } from '../scripts/vercel/session-uat-evidence.mjs';

async function driverSource(): Promise<string> {
  const files = [
    'scripts/vercel/session-uat.mjs',
    'scripts/vercel/session-uat-orchestrator.mjs',
    'scripts/vercel/session-uat-probes.mjs',
    'scripts/vercel/session-uat-cleanup.mjs',
    'scripts/vercel/session-uat-evidence.mjs',
  ];
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}

describe('public Vercel session UAT driver', () => {
  it('drives the built CLI through a PTY for both duration and reconnect paths', async () => {
    const source = await driverSource();

    expect(source).toContain("spawn('script'");
    expect(source).toContain("process.execPath");
    expect(source).toContain("'--provider',");
    expect(source).toContain("'--expose-ports',");
    expect(source).toContain("'--attach'");
    expect(source).toContain("'--timeout'");
    expect(source).toContain("close('SIGKILL')");
    expect(source).toContain('remoteHttpFixtureCommand');
    expect(source).toContain('waitForFixture');
    expect(source).toContain('readProviderSessionFacts');
    expect(source).toContain('configuredTimeoutMs');
    expect(source).toContain('createdAt');
    expect(source).toContain('expiresAt');
    expect(source).toContain('waitForProviderStop');
    expect(source).toContain('one retained snapshot');
    expect(source).toContain('duration idle provider session');
    expect(source).toContain('duration final provider session');
    expect(source).toContain('parseDetachedProcessStartup');
    expect(source).toContain('kill -0');
    expect(source).toContain('DURATION_IDLE_BOUNDARY_MS');
    expect(source).toContain('DURATION_FINAL_WINDOW_MS');
    expect(source).toContain('duration idle deadline unchanged');
    expect(source).toContain('duration final deadline unchanged');
    expect(source).toContain('duration natural stop boundary');
    expect(source).toContain('terminalAt');
    expect(source).toContain('same HTTP response');
    expect(source).toContain('forced-close same provider session');
    expect(source).toContain('clean attach same provider session');
    expect(source).toContain('forced-close same foreground PID');
    expect(source).toContain('clean Ctrl-] detach');
    expect(source).toContain('snapshot fresh socket');
    expect(source).toContain('snapshot prior process ended');
    expect(source).toContain('prior user processes ended');
    expect(source).toContain('waitForPublicRoute');
    expect(source).toContain('snapshot display route healthy');
    expect(source).toContain('snapshot public route healthy');
    expect(source).toContain('snapshot workspace restored');
    expect(source).toContain('snapshot branch restored');
    expect(source).toContain('snapshot runtime state restored');
    expect(source).toContain('snapshot fresh provider session');
  });

  it('writes redacted evidence and has an explicit cleanup mode', async () => {
    const source = await driverSource();

    expect(source).toContain('redacted: false');
    expect(source).toContain("createHash('sha256')");
    expect(source).toContain("argv[2] === '--cleanup'");
    expect(source).toContain('XDG_STATE_HOME');
    expect(source).toContain('DEVBOX_UAT_REPORT');
    expect(source).toContain('runCleanup(stateHome)');
    expect(source).toContain('removeRunTaggedLeftovers');
    expect(source).toContain('targets.set(identity.name');
    expect(source).toContain('/actions/runs/${parsed.runId}/attempts/${parsed.runAttempt}');
    expect(source).toContain('DEVBOX_UAT_REPOSITORY');
    expect(source).toContain('mode,');
    expect(source).toContain('loadCleanupDependencies');
    expect(source).toContain('redact(session.output())');
    expect(source).not.toContain('fallbackCleanupSandbox');
  });

  it('keeps workflow-run eligibility independent for rerun attempts in either order', async () => {
    const calls: string[] = [];
    const eligibility = createWorkflowRunEligibility({
      repository: 'gannonh/devbox',
      fetcher: async (url) => {
        calls.push(url);
        const attempt = Number(url.match(/attempts\/(\d+)$/)?.[1]);
        return {
          ok: true,
          json: async () => ({
            status: attempt === 2 ? 'completed' : 'cancelled',
            run_attempt: attempt,
          }),
        } as Response;
      },
    });
    const identity = { tags: { repository: 'repository-tag', branch: 'other-branch' } };
    const attemptOne = { name: 'attempt-one', tags: { provider: 'vercel', repository: 'repository-tag', branch: 'uat-devbox-session-900-1-aaaaaaaaaaaaaaaa' } };
    const attemptTwo = { name: 'attempt-two', tags: { provider: 'vercel', repository: 'repository-tag', branch: 'uat-devbox-session-900-2-bbbbbbbbbbbbbbbb' } };

    await expect(selectRunTaggedSandboxes([attemptTwo, attemptOne], identity, eligibility)).resolves.toEqual([attemptTwo]);
    await expect(selectRunTaggedSandboxes([attemptOne, attemptTwo], identity, eligibility)).resolves.toEqual([attemptTwo]);
    expect(calls).toEqual([
      'https://api.github.com/repos/gannonh/devbox/actions/runs/900/attempts/2',
      'https://api.github.com/repos/gannonh/devbox/actions/runs/900/attempts/1',
    ]);
  });

  it('fails closed when the canonical cleanup build is unavailable', async () => {
    await expect(loadCleanupDependencies(async () => {
      throw new Error('dist is unavailable');
    })).rejects.toThrow('dist is unavailable');
  });

  it('proves cleanup inventory convergence after a transient residual', async () => {
    const inventories = [
      { sandboxCount: 1, snapshotCount: 1 },
      { sandboxCount: 0, snapshotCount: 0 },
    ];
    let now = 0;
    await expect(waitForEmptyResourceInventory(
      async () => inventories.shift()!,
      { timeoutMs: 10, pollMs: 1, sleep: async () => {}, now: () => now++ },
    )).resolves.toEqual({ sandboxCount: 0, snapshotCount: 0 });
  });

  it('creates the stable redacted report shape before any provider work', () => {
    const evidence = createEvidence({
      mode: 'duration',
      branch: 'feature/session',
      timeoutMinutes: 60,
      reportPath: '/tmp/session-uat-report.json',
      deadlineToleranceMs: 5_000,
      environment: { VERCEL_TOKEN: 'secret-token' },
    });

    expect(evidence.report).toMatchObject({
      schemaVersion: 1,
      redacted: false,
      mode: 'duration',
      timeoutMinutes: 60,
      checks: [],
      preflight: { attempted: false, accepted: false },
      cleanup: { attempted: false, accepted: false },
    });
    evidence.check('redaction boundary', true, 'secret-token');
    expect(evidence.report.checks[0]?.detail).toBe('[REDACTED]');
  });
});
