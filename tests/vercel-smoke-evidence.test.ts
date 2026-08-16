import { describe, expect, it } from 'vitest';
import {
  aggregateCleanupEvidence,
  createConfigurationEvidence,
  createEmptyPreflightEvidence,
  createPathReport,
  createPreflightEvidence,
  createRunIdentity,
  fingerprintEvidence,
  hasTerminalSessionProof,
  sanitizeRecoveryEvidence,
} from '../scripts/vercel/smoke-evidence.mjs';

describe('provider smoke evidence', () => {
  it('records redacted preflight cleanup evidence without raw names or tags', () => {
    const preflight = createPreflightEvidence({
      namePrefix: 'devbox-vercel-v-provider-smoke-',
      repositoryTag: 'github-com-secret-owner-private-fixture-abcdef1234567890',
      discovered: ['sandbox-secret-name'],
      ignored: ['sandbox-invalid-name'],
      cleaned: ['sandbox-secret-name'],
      residual: [{ name: 'sandbox-residual-name', status: 'stopped' }],
      discoveryConverged: true,
      snapshotsCleaned: true,
      sessionProof: true,
      errors: ['sandbox secret-name remains'],
      redact: (value) => String(value).replaceAll('secret-name', '[REDACTED]'),
    });

    expect(createEmptyPreflightEvidence().attempted).toBe(false);
    expect(JSON.stringify(preflight)).not.toContain('secret-owner');
    expect(JSON.stringify(preflight)).not.toContain('sandbox-secret-name');
    expect(preflight).toMatchObject({
      attempted: true,
      discoveryConverged: true,
      snapshotsCleaned: true,
      sessionProof: true,
      errors: ['sandbox [REDACTED] remains'],
      discoveredSandboxes: [{ nameFingerprint: expect.any(String) }],
      residualSandboxes: [{ status: 'stopped' }],
    });
  });

  it('stores fingerprints instead of fixture and scope identities', () => {
    const config = {
      path: 'existing',
      fixture: {
        repository: 'secret-owner/private-fixture',
        branch: 'secret-branch',
        defaultBranch: 'secret-default',
        expectedFile: 'private/fixture.txt',
        expectedContent: 'secret fixture content',
      },
      credentials: { teamId: 'vercel-team-secret', projectId: 'vercel-project-secret' },
    };
    const pathReport = createPathReport({
      label: 'existing',
      requestedBranch: config.fixture.branch,
      sourceRevision: config.fixture.defaultBranch,
      identity: {
        name: 'sandbox-secret-owner-private-fixture-secret-branch',
        tags: { repository: config.fixture.repository, branch: config.fixture.branch, identity: 'identity-secret' },
      },
      credentials: config.credentials,
    });
    const evidence = createConfigurationEvidence(config);
    const serialized = JSON.stringify({ pathReport, evidence });

    for (const secret of [
      config.fixture.repository,
      config.fixture.branch,
      config.fixture.defaultBranch,
      config.fixture.expectedFile,
      config.fixture.expectedContent,
      config.credentials.teamId,
      config.credentials.projectId,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(pathReport.requestedBranchFingerprint).toBe(fingerprintEvidence(config.fixture.branch));
  });

  it('keeps standalone reports unredacted until the workflow redactor runs', () => {
    expect(createRunIdentity({ GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }, 'fixed'))
      .toBe('run-123-2-fixed');
  });

  it('does not claim a no-running-session proof from empty recovery discovery', () => {
    expect(hasTerminalSessionProof([])).toBe(false);
    expect(hasTerminalSessionProof([{ id: 'session', status: 'stopped' }])).toBe(true);
    expect(sanitizeRecoveryEvidence({
      attempts: 1,
      discoveryConverged: true,
      snapshotsCleaned: true,
      errors: ['sandbox secret-name remains'],
      discoveredSandboxes: ['sandbox-secret-name'],
      finalSandboxes: [],
      finalSnapshots: [],
      residualSandboxes: [],
      residualSnapshots: [],
    }, (value: unknown) => String(value).replaceAll('secret-name', '[REDACTED]'))).toMatchObject({
      discoveredSandboxes: [{ nameFingerprint: expect.any(String) }],
      errors: ['sandbox [REDACTED] remains'],
    });
  });

  it('requires all final cleanup aggregate flags for process success', () => {
    const path = {
      failed: false,
      cleanup: {
        stopped: true,
        deleted: true,
        deletionVerified: true,
        noRunningSessionAfterDelete: true,
        discoveryConverged: true,
        snapshotsCleaned: true,
        finalSessionStatesTerminal: true,
        residualNonDeletedSnapshots: [],
        errors: [],
      },
    };
    expect(aggregateCleanupEvidence([path]).processSuccess).toBe(true);
    expect(aggregateCleanupEvidence([{ ...path, cleanup: { ...path.cleanup, noRunningSessionAfterDelete: false } }]).processSuccess).toBe(false);
  });
});
