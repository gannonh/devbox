import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createWorkflowRunEligibility,
  loadCleanupDependencies,
  selectRunTaggedSandboxes,
  waitForEmptyResourceInventory,
} from '../scripts/vercel/session-uat-cleanup.mjs';
import { createEvidence, redactTailValue } from '../scripts/vercel/session-uat-evidence.mjs';
import { createSessionUatProbes, sessionSocketPath, waitForExit, waitForOutput } from '../scripts/vercel/session-uat-probes.mjs';

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
    expect(source).toContain('sessionIdFingerprint');
    expect(source).toContain('sandboxNameFingerprint');
    expect(source).toContain('idFingerprint');
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
    expect(source).toContain('initial socket matches provider session');
    expect(source).toContain('snapshot socket matches provider session');
    expect(source).toContain('snapshot fresh deadline');
    expect(source).toContain('snapshot prior process ended');
    expect(source).toContain('prior user processes ended');
    expect(source).toContain('waitForPublicRoute');
    expect(source).toContain('fetchTextWithTimeout');
    expect(source).toContain('boundedCall');
    expect(source).toContain('signal: signal');
    expect(source).toContain('snapshot display route healthy');
    expect(source).toContain('snapshot public route healthy');
    expect(source).toContain('snapshot workspace restored');
    expect(source).toContain('snapshot branch restored');
    expect(source).toContain('snapshot runtime state restored');
    expect(source).toContain('snapshot fresh provider session');
    expect(source).toContain('parseIdentity(session.output(), marker)');
    expect(source).toContain('return session.output();');
    expect(source).not.toContain("waitFor('▲ ', cliTimeoutMs)");
    expect(source).not.toContain("'▲ ',");
  });

  it('parses complete PTY records after their readiness markers', () => {
    const probes = createSessionUatProbes({
      branch: 'feature/session',
      repoRoot: '/tmp',
      cliPath: '/tmp/cli.js',
      environment: {},
      markerTimeoutMs: 1_000,
      providerPollMs: 1,
      redact: (value) => value,
    });

    expect(probes.parseIdentity(
      'ubuntu@uat:~$ PID=41 TMUX=devbox SOCKET=/tmp/devbox-tmux/session-a/socket\nDEVBOX_UAT_identity',
      'DEVBOX_UAT_identity',
    )).toEqual({
      pid: '41',
      session: 'devbox',
      socket: '/tmp/devbox-tmux/session-a/socket',
    });
    expect(probes.parseFixtureStartup(
      'PID=42 TMUX=devbox\nDEVBOX_UAT_fixture',
      'DEVBOX_UAT_fixture',
    )).toEqual({ marker: 'DEVBOX_UAT_fixture', pid: '42', session: 'devbox' });
    expect(probes.parseDetachedProcessStartup(
      'PID=43 MARKER=process-marker\nDEVBOX_UAT_started',
      'DEVBOX_UAT_started',
    )).toEqual({ marker: 'process-marker', pid: '43' });
    expect(probes.parseWorkspace(
      'PWD=/vercel/sandbox BRANCH=feature/session\nDEVBOX_UAT_workspace',
      'DEVBOX_UAT_workspace',
    )).toEqual({ path: '/vercel/sandbox', branch: 'feature/session' });
    expect(sessionSocketPath('session-1')).toBe('/tmp/devbox-tmux/session-c2Vzc2lvbi0x/socket');
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
    expect(source).toContain('redactTail(session.output())');
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

  it('does not cache a timed-out workflow eligibility lookup', async () => {
    let calls = 0;
    const eligibility = createWorkflowRunEligibility({
      repository: 'gannonh/devbox',
      fetcher: async (_url: string, init: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          });
        }
        return {
          ok: true,
          json: async () => ({ status: 'completed', run_attempt: 1 }),
        } as Response;
      },
    });
    const identity = { tags: { repository: 'repository-tag', branch: 'other-branch' } };
    const record = { name: 'attempt-one', tags: { provider: 'vercel', repository: 'repository-tag', branch: 'uat-devbox-session-900-1-aaaaaaaaaaaaaaaa' } };

    await expect(selectRunTaggedSandboxes([record], identity, eligibility, undefined, AbortSignal.timeout(5)))
      .resolves.toEqual([]);
    await expect(selectRunTaggedSandboxes([record], identity, eligibility)).resolves.toEqual([record]);
    expect(calls).toBe(2);
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

  it('aborts a cleanup inventory request at its operation deadline', async () => {
    let aborted = false;
    await expect(waitForEmptyResourceInventory(
      (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      { timeoutMs: 30, pollMs: 1, operationTimeoutMs: 5, sleep: async () => {} },
    )).rejects.toThrow(/did not converge/);
    expect(aborted).toBe(true);
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

  it('retains the redacted tail of a long diagnostic output', () => {
    const detail = redactTailValue(`${'prefix '.repeat(300)} private-token provider startup failed`, ['private-token']);

    expect(detail).toContain('provider startup failed');
    expect(detail).not.toContain('private-token');
    expect(detail.length).toBeLessThanOrEqual(1200);
  });

  it('redacts display access codes from captured diagnostics', () => {
    const detail = redactTailValue('Vercel devbox ready\n  access code: display-code-123', []);

    expect(detail).toBe('Vercel devbox ready\n  access code: [REDACTED]');
  });

  it('redacts device authorization URLs and codes from captured diagnostics', () => {
    const detail = redactTailValue([
      'Vercel device authorization URL: https://vercel.com/device?user_code=DEVICE-CODE',
      'Vercel device authorization code: DEVICE-CODE',
      'fallback URL: https://vercel.com/device?code=DEVICE-CODE',
    ].join('\n'), []);

    expect(detail).toContain('https://vercel.com/device?user_code=[REDACTED]');
    expect(detail).toContain('Vercel device authorization code: [REDACTED]');
    expect(detail).toContain('https://vercel.com/device?code=[REDACTED]');
    expect(detail).not.toContain('DEVICE-CODE');
  });

  it('observes an already-exited PTY without waiting for its timeout', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 0,
      signalCode: null,
    });

    await expect(waitForOutput(child, () => false, 1_000))
      .rejects.toThrow('CLI PTY exited before the marker appeared');
    await expect(waitForExit(child, 1_000)).resolves.toBe(0);
  });
});
