import { createHash, randomUUID } from 'node:crypto';

const TERMINAL_SESSION_STATES = new Set(['stopped', 'aborted']);

export function fingerprintEvidence(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

export function safeIdentityPart(value) {
  const sanitized = String(value).replace(/[^a-zA-Z0-9-]/g, '-');
  return sanitized.slice(0, 32) || 'local';
}

export function createRunIdentity(env = process.env, suffix = randomUUID().replaceAll('-', '').slice(0, 12)) {
  const workflowRun = env.GITHUB_RUN_ID ?? 'local';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  return `run-${safeIdentityPart(workflowRun)}-${safeIdentityPart(attempt)}-${safeIdentityPart(suffix)}`;
}

export function createPathReport({ label, requestedBranch, sourceRevision, identity, credentials }) {
  return {
    label,
    requestedBranchFingerprint: fingerprintEvidence(requestedBranch),
    sourceRevisionFingerprint: fingerprintEvidence(sourceRevision),
    sandboxNameFingerprint: fingerprintEvidence(identity.name),
    identityTagFingerprints: Object.fromEntries(
      Object.entries(identity.tags ?? {}).map(([key, value]) => [key, fingerprintEvidence(value)]),
    ),
    scope: {
      teamIdFingerprint: fingerprintEvidence(credentials.teamId),
      projectIdFingerprint: fingerprintEvidence(credentials.projectId),
    },
    checks: [],
    timings: {},
    sessions: [],
    snapshots: [],
    cleanup: createEmptyCleanupEvidence(),
  };
}

export function createConfigurationEvidence(config, budget) {
  return {
    path: config.path,
    ...(budget === undefined ? {} : { budget }),
    fixture: {
      repositoryFingerprint: fingerprintEvidence(config.fixture.repository),
      branchFingerprint: fingerprintEvidence(config.fixture.branch),
      defaultBranchFingerprint: fingerprintEvidence(config.fixture.defaultBranch),
      expectedFileFingerprint: fingerprintEvidence(config.fixture.expectedFile),
      expectedContentFingerprint: fingerprintEvidence(config.fixture.expectedContent),
    },
    scope: {
      teamIdFingerprint: fingerprintEvidence(config.credentials.teamId),
      projectIdFingerprint: fingerprintEvidence(config.credentials.projectId),
    },
  };
}

export function createFixtureEvidence(config, fixture) {
  return {
    repository: {
      private: fixture.repository.private,
      fullNameFingerprint: fingerprintEvidence(config.fixture.repository),
      defaultBranchFingerprint: fingerprintEvidence(config.fixture.defaultBranch),
    },
    defaultBranch: {
      sha: fixture.defaultBranch.sha,
    },
    existingBranch: fixture.existingBranch === undefined
      ? { exists: false }
      : { exists: true, sha: fixture.existingBranch.sha },
  };
}

export function createEmptyCleanupEvidence() {
  return {
    stopped: false,
    deleted: false,
    deletionVerified: false,
    noRunningSessionAfterDelete: false,
    discoveryConverged: false,
    snapshotsCleaned: false,
    finalSessionStatesTerminal: false,
    residualNonDeletedSnapshots: [],
    errors: [],
  };
}

export function hasTerminalSessionProof(sessions) {
  return Array.isArray(sessions)
    && sessions.length > 0
    && sessions.every((session) => TERMINAL_SESSION_STATES.has(session?.status));
}

export function cleanupProcessSuccess(pathReport) {
  const cleanup = pathReport?.cleanup;
  return pathReport?.failed !== true
    && cleanup?.stopped === true
    && cleanup?.deleted === true
    && cleanup?.deletionVerified === true
    && cleanup?.noRunningSessionAfterDelete === true
    && cleanup?.discoveryConverged === true
    && cleanup?.snapshotsCleaned === true
    && cleanup?.finalSessionStatesTerminal === true
    && Array.isArray(cleanup?.residualNonDeletedSnapshots)
    && cleanup.residualNonDeletedSnapshots.length === 0
    && Array.isArray(cleanup?.errors)
    && cleanup.errors.length === 0;
}

export function aggregateCleanupEvidence(pathReports) {
  const paths = Array.isArray(pathReports) ? pathReports : [];
  const cleanup = {
    stopped: paths.length > 0 && paths.every((path) => path.cleanup.stopped === true),
    deleted: paths.length > 0 && paths.every((path) => path.cleanup.deleted === true),
    deletionVerified: paths.length > 0 && paths.every((path) => path.cleanup.deletionVerified === true),
    noRunningSessionAfterDelete: paths.length > 0 && paths.every((path) => path.cleanup.noRunningSessionAfterDelete === true),
    discoveryConverged: paths.length > 0 && paths.every((path) => path.cleanup.discoveryConverged === true),
    snapshotsCleaned: paths.length > 0 && paths.every((path) => path.cleanup.snapshotsCleaned === true),
    finalSessionStatesTerminal: paths.length > 0 && paths.every((path) => path.cleanup.finalSessionStatesTerminal === true),
    residualNonDeletedSnapshots: paths.flatMap((path) => path.cleanup.residualNonDeletedSnapshots ?? []),
    errors: paths.flatMap((path) => path.cleanup.errors ?? []),
  };
  return {
    ...cleanup,
    processSuccess: paths.length > 0 && paths.every((path) => cleanupProcessSuccess(path)),
  };
}

export function sanitizeRecoveryEvidence(recovery, redact = (value) => String(value)) {
  const fingerprintNames = (values) => (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((name) => ({ nameFingerprint: fingerprintEvidence(name) }));
  const safeSandboxes = (values) => (Array.isArray(values) ? values : [])
    .filter((sandbox) => sandbox && typeof sandbox.name === 'string')
    .map((sandbox) => ({
      nameFingerprint: fingerprintEvidence(sandbox.name),
      ...(sandbox.status === undefined ? {} : { status: sandbox.status }),
    }));
  const safeSnapshots = (values) => (Array.isArray(values) ? values : [])
    .filter((snapshot) => snapshot && typeof snapshot.id === 'string')
    .map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
  return {
    attempts: recovery.attempts,
    discoveryConverged: recovery.discoveryConverged === true,
    snapshotsCleaned: recovery.snapshotsCleaned === true,
    sessionProof: recovery.sessionProof === true,
    recoveredSandboxes: fingerprintNames(recovery.recoveredSandboxes),
    discoveredSandboxes: fingerprintNames(recovery.discoveredSandboxes),
    finalSandboxes: safeSandboxes(recovery.finalSandboxes),
    residualSandboxes: safeSandboxes(recovery.residualSandboxes),
    deletedSnapshots: Array.isArray(recovery.deletedSnapshots) ? [...recovery.deletedSnapshots] : [],
    finalSnapshots: safeSnapshots(recovery.finalSnapshots),
    residualSnapshots: safeSnapshots(recovery.residualSnapshots),
    errors: Array.isArray(recovery.errors) ? recovery.errors.map((error) => redact(error)) : [],
  };
}
