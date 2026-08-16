#!/usr/bin/env node
/**
 * Credentialed provider smoke for the production Vercel adapters.
 *
 * This script deliberately uses the pinned @vercel/sandbox v3 client and the
 * production terminal adapter. It never invokes the Vercel CLI, never places a
 * credential in argv, and writes only redaction-safe evidence.
 */
import { randomUUID } from 'node:crypto';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { dirname } from 'node:path';
import {
  assertPromotedVercelImagePin,
  parseVercelProviderSmokeConfig,
} from '../../dist/providers/vercel/smoke-config.js';
import {
  buildVercelSandboxCreateRequest,
  createVercelSandboxClient,
  isVercelNotFound,
} from '../../dist/providers/vercel/client.js';
import { cleanupVercelSandbox } from '../../dist/providers/vercel/cleanup.js';
import {
  createVercelIdentity,
} from '../../dist/providers/vercel/identity.js';
import { VERCEL_IMAGE_PIN } from '../../dist/providers/vercel/image.js';
import { normalizeGitHubSourceRemote } from '../../dist/providers/vercel/source.js';
import { createVercelTerminalAdapter } from '../../dist/providers/vercel/terminal.js';
import { boundedCall } from './sandbox-cleanup.mjs';
import {
  applyOwnedRecoveryEvidence,
  recoverOwnedResources,
} from './sandbox-owned-recovery.mjs';
import { deleteListedSnapshot } from './snapshot-cleanup.mjs';
import { fetchWithTimeout } from './http-probe.mjs';

const startedAt = Date.now();
const reportPath = process.env.SMOKE_REPORT;
let secretValues = [];
const runIdentity = createRunIdentity();
const report = {
  schemaVersion: 1,
  redacted: false,
  failed: false,
  runIdentity,
  imageReference: VERCEL_IMAGE_PIN.reference,
  paths: [],
  cleanup: {
    stopped: false,
    deleted: false,
    deletionVerified: false,
    noRunningSessionAfterDelete: false,
    discoveryConverged: false,
    snapshotsCleaned: false,
    finalSessionStatesTerminal: false,
    residualNonDeletedSnapshots: [],
    errors: [],
  },
  startedAt: new Date(startedAt).toISOString(),
};

const smokeTimeoutMs = positiveTimeout('SMOKE_TIMEOUT_MS', 12 * 60 * 1000);
const operationTimeoutMs = positiveTimeout('SMOKE_OPERATION_TIMEOUT_MS', 30_000);
const commandTimeoutMs = positiveTimeout('SMOKE_COMMAND_TIMEOUT_MS', 60_000);
const cleanupTimeoutMs = positiveTimeout('SMOKE_CLEANUP_TIMEOUT_MS', 120_000);
const terminalTimeoutMs = positiveTimeout('SMOKE_TERMINAL_TIMEOUT_MS', 90_000);
const githubTimeoutMs = positiveTimeout('SMOKE_GITHUB_TIMEOUT_MS', 10_000);

function createRunIdentity() {
  const workflowRun = process.env.GITHUB_RUN_ID ?? 'local';
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  return `run-${safeIdentityPart(workflowRun)}-${safeIdentityPart(attempt)}-${suffix}`;
}

function safeIdentityPart(value) {
  const sanitized = String(value).replace(/[^a-zA-Z0-9-]/g, '-');
  return sanitized.slice(0, 32) || 'local';
}

function initializeSecretValues() {
  secretValues = [
    process.env.VERCEL_TOKEN,
    process.env.GITHUB_FIXTURE_TOKEN,
  ].filter((value) => typeof value === 'string' && value.length > 0);
}

function positiveTimeout(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return Math.ceil(value);
}

function redactText(value) {
  let output = String(value);
  for (const secret of secretValues) {
    output = output.split(secret).join('[REDACTED]');
    output = output.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return output
    .replace(/(authorization\s*:\s*Basic\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp_|github_pat_|vcp_|vercel_)[A-Za-z0-9_~-]+/gi, '[REDACTED]');
}

function errorMessage(error) {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function recordCheck(target, name, ok, detail = '') {
  target.checks ??= [];
  target.checks.push({ name, ok, detail: redactText(detail).slice(0, 300) });
  if (!ok) throw new Error(`${name} failed${detail ? `: ${redactText(detail)}` : ''}`);
}

function recordTiming(target, stage, started, outcome, error) {
  const finished = Date.now();
  target.timings ??= {};
  target.timings[stage] = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    startedEpochMs: started,
    finishedEpochMs: finished,
    durationMs: finished - started,
    outcome,
    ...(error === undefined ? {} : { error: errorMessage(error) }),
  };
}

async function timed(target, stage, operation, signal, timeoutMs) {
  const stageStarted = Date.now();
  try {
    const result = await boundedCall(operation, stage, { signal, timeoutMs });
    recordTiming(target, stage, stageStarted, 'passed');
    return result;
  } catch (error) {
    recordTiming(target, stage, stageStarted, 'failed', error);
    throw error;
  }
}

async function githubJson(config, endpoint, signal, allowNotFound = false) {
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${config.fixture.repository}${endpoint}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${config.fixture.token}`,
      },
    },
    githubTimeoutMs,
    signal,
  );
  const body = await response.text();
  if (allowNotFound && response.status === 404) return { exists: false };
  if (!response.ok) throw new Error(`GitHub fixture API ${endpoint} returned HTTP ${response.status}`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`GitHub fixture API ${endpoint} returned invalid JSON`);
  }
  return { exists: true, value: parsed };
}

async function inspectFixture(config, signal) {
  const repositoryResponse = await githubJson(config, '', signal);
  const repository = repositoryResponse.value;
  if (repository.private !== true) throw new Error('GITHUB_FIXTURE_REPOSITORY must be private');
  if (String(repository.full_name ?? '').toLowerCase() !== config.fixture.repository.toLowerCase()) {
    throw new Error('GitHub fixture API returned a different repository than configured');
  }
  if (repository.default_branch !== config.fixture.defaultBranch) {
    throw new Error(
      `GitHub fixture default branch mismatch: expected ${config.fixture.defaultBranch}, observed ${String(repository.default_branch ?? '')}`,
    );
  }

  const branchEndpoint = `/branches/${encodeURIComponent(config.fixture.branch)}`;
  const branchResponse = await githubJson(config, branchEndpoint, signal, true);
  const defaultBranchResponse = await githubJson(
    config,
    `/branches/${encodeURIComponent(config.fixture.defaultBranch)}`,
    signal,
  );
  const defaultSha = String(defaultBranchResponse.value?.commit?.sha ?? '');
  if (!/^[a-f0-9]{40}$/.test(defaultSha)) {
    throw new Error(`GitHub fixture default branch did not provide a full commit SHA`);
  }
  return {
    repository: {
      private: repository.private,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
    },
    defaultBranch: { name: config.fixture.defaultBranch, sha: defaultSha },
    existingBranch: branchResponse.exists
      ? { name: config.fixture.branch, sha: String(branchResponse.value?.commit?.sha ?? '') }
      : undefined,
  };
}

function createMissingBranch(config) {
  return `devbox-smoke/${safeIdentityPart(runIdentity)}-${safeIdentityPart(config.fixture.branch)}`;
}

function buildSource(config, remote, requestedBranch, revision, requestedBranchExists) {
  return {
    remote,
    defaultBranch: config.fixture.defaultBranch,
    requestedBranch,
    requestedBranchExists,
    needsBranchSetup: !requestedBranchExists,
    source: {
      type: 'git',
      url: remote.url,
      revision,
      username: 'x-access-token',
      password: config.fixture.token,
    },
    warning: '',
  };
}

function createPathReport(label, requestedBranch, sourceRevision, identity) {
  return {
    label,
    requestedBranch,
    sourceRevision,
    sandboxName: identity.name,
    tags: { ...identity.tags },
    checks: [],
    timings: {},
    sessions: [],
    snapshots: [],
    cleanup: {
      stopped: false,
      deleted: false,
      deletionVerified: false,
      noRunningSessionAfterDelete: false,
      discoveryConverged: false,
      snapshotsCleaned: false,
      finalSessionStatesTerminal: false,
      residualNonDeletedSnapshots: [],
      errors: [],
    },
  };
}

async function runCommand(client, sandbox, command, args, signal) {
  const result = await client.runCommand(sandbox, command, args, {
    signal,
    timeoutMs: commandTimeoutMs,
  });
  const [stdout, stderr] = await Promise.all([
    result.stdout ? result.stdout({ signal }) : Promise.resolve(''),
    result.stderr ? result.stderr({ signal }) : Promise.resolve(''),
  ]);
  return { exitCode: result.exitCode, stdout, stderr };
}

async function assertRepository(client, sandbox, config, pathReport, expected, signal) {
  const remote = await runCommand(client, sandbox, 'git', ['remote', 'get-url', 'origin'], signal);
  recordCheck(pathReport, 'private clone remote', remote.exitCode === 0 && remote.stdout.trim() === expected.remoteUrl, `exitCode=${remote.exitCode}`);

  const head = await runCommand(client, sandbox, 'git', ['rev-parse', 'HEAD'], signal);
  recordCheck(pathReport, 'private clone HEAD', head.exitCode === 0 && /^[a-f0-9]{40}$/.test(head.stdout.trim()) && head.stdout.trim() === expected.sha, `exitCode=${head.exitCode}`);

  const branch = await runCommand(client, sandbox, 'git', ['branch', '--show-current'], signal);
  recordCheck(pathReport, 'private clone requested branch', branch.exitCode === 0 && branch.stdout.trim() === expected.branch, `exitCode=${branch.exitCode}`);

  const content = await runCommand(client, sandbox, 'cat', ['--', config.fixture.expectedFile], signal);
  recordCheck(pathReport, 'private clone expected content', content.exitCode === 0 && content.stdout === config.fixture.expectedContent, `exitCode=${content.exitCode}`);

  const status = await runCommand(client, sandbox, 'git', ['status', '--porcelain'], signal);
  recordCheck(pathReport, 'private clone clean worktree', status.exitCode === 0 && status.stdout.trim() === '', `exitCode=${status.exitCode}`);
}

function waitForOutput(stream, marker, timeoutMs, signal, currentOutput = () => '') {
  return new Promise((resolve, reject) => {
    let output = currentOutput();
    if (output.includes(marker)) {
      resolve(output);
      return;
    }
    let timer;
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) finish();
    };
    const onAbort = () => finish(signal.reason ?? new Error('terminal output wait aborted'));
    const finish = (error) => {
      stream.removeListener('data', onData);
      signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      if (error instanceof Error) reject(error);
      else resolve(output);
    };
    stream.on('data', onData);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error(`terminal output did not contain ${marker}`)), timeoutMs);
  });
}

async function runInteractiveTerminal(sandbox, pathReport, signal, terminalAdapter) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signalSource = new EventEmitter();
  let terminalError;
  const output = [];
  stdout.on('data', (chunk) => output.push(chunk.toString()));
  stderr.on('data', (chunk) => output.push(chunk.toString()));

  // Call the production SDK method explicitly before the adapter owns the
  // protocol. The adapter calls it again to obtain the actual PTY token.
  await sandbox.openInteractive({ signal });
  const attach = terminalAdapter.attach(sandbox, {
    streams: { stdin, stdout, stderr },
    tty: false,
    signal,
    signalSource,
    timeoutExtension: false,
    getSize: () => ({ cols: 100, rows: 30 }),
    onError: (failure) => {
      terminalError = failure.message;
      return true;
    },
  });
  const capturedOutput = () => output.join('');
  const readyMarker = `provider-smoke-ready-${pathReport.label}`;
  const encodedReadyMarker = Buffer.from(readyMarker).toString('base64');
  stdin.write(`printf "%s\\n" "$(printf "%s" "${encodedReadyMarker}" | base64 -d)"\n`);
  await waitForOutput(stdout, readyMarker, terminalTimeoutMs, signal, capturedOutput);
  const interruptMarker = `provider-smoke-interrupted-${pathReport.label}`;
  const encodedInterruptMarker = Buffer.from(interruptMarker).toString('base64');
  const sleepMarker = `provider-smoke-sleeping-${pathReport.label}`;
  const encodedSleepMarker = Buffer.from(sleepMarker).toString('base64');
  stdin.write(`trap 'printf "%s\\n" "$(printf "%s" "${encodedInterruptMarker}" | base64 -d)"' INT; printf "%s\\n" "$(printf "%s" "${encodedSleepMarker}" | base64 -d)"; sleep 30\n`);
  await waitForOutput(stdout, sleepMarker, terminalTimeoutMs, signal, capturedOutput);
  const outputBeforeInterrupt = capturedOutput();
  signalSource.emit('SIGINT');
  await waitForOutput(stdout, interruptMarker, terminalTimeoutMs, signal, capturedOutput);
  const outputAfterInterrupt = capturedOutput().slice(outputBeforeInterrupt.length);
  stdin.write(`printf 'provider-smoke-after-interrupt-${pathReport.label}\\n'\nexit\n`);
  const result = await boundedCall(
    () => attach,
    'interactive terminal completion',
    { signal, timeoutMs: terminalTimeoutMs },
  );
  recordCheck(pathReport, 'openInteractive terminal', result.status === 'exited' && result.code === 0, terminalError ?? 'terminal completed');
  recordCheck(pathReport, 'Ctrl-C terminal protocol', outputAfterInterrupt.includes(interruptMarker), 'remote trap observed SIGINT after it was sent through the terminal adapter');
  pathReport.terminal = {
    status: result.status,
    ...(result.status === 'exited' ? { exitCode: result.code } : { reason: result.reason }),
    outputMarkers: output.filter((value) => value.includes('provider-smoke-')).length,
  };
}

function cleanupAdapter(client) {
  return {
    get: (request) => client.get(request),
    listSessions: (sandbox, options) => client.listSessions(sandbox, options),
    stop: (sandbox, options) => client.stopSandbox(sandbox, options),
    listSnapshots: (request) => client.listSnapshots(request),
    getSnapshot: (request) => client.getSnapshot(request),
    delete: (sandbox, options) => client.deleteSandbox(sandbox, options),
    deleteByName: (request) => client.deleteSandboxByName(request),
  };
}

async function recoverOwned(client, credentials, identity, pathReport, signal) {
  const adapter = cleanupAdapter(client);
  const recovery = await recoverOwnedResources({
    timeoutMs: cleanupTimeoutMs,
    operationTimeoutMs,
    signal,
    listSandboxes: ({ signal: requestSignal }) => client.listSandboxes({
      credentials,
      namePrefix: identity.name,
      tags: { ...identity.tags },
      signal: requestSignal,
    }),
    recoverSandbox: async (name, { signal: requestSignal }) => {
      const result = await cleanupVercelSandbox({
        name,
        credentials,
        expectedTags: identity.tags,
        adapter,
        timeoutMs: Math.min(cleanupTimeoutMs, operationTimeoutMs * 4),
        maxAttempts: 4,
        signal: requestSignal,
      });
      pathReport.sessions.push({ phase: `recovery-${name}`, states: result.finalSessions.map(sessionState) });
      if (result.finalSessions.length > 0) {
        pathReport.cleanup.finalSessionStatesTerminal = result.finalSessions.every((session) => ['stopped', 'aborted'].includes(session.status));
      }
      if (!result.verified) throw new Error(`owned Sandbox ${name} cleanup did not converge`);
    },
    listSnapshots: ({ signal: requestSignal }) => client.listSnapshots({
      credentials,
      name: identity.name,
      signal: requestSignal,
    }),
    deleteSnapshot: (snapshot, { signal: requestSignal }) => deleteListedSnapshot({
      snapshot,
      signal: requestSignal,
      timeoutMs: operationTimeoutMs,
      label: 'provider smoke snapshot',
      getSnapshot: (snapshotId, getSignal) => client.getSnapshot({
        credentials,
        snapshotId,
        signal: getSignal,
      }),
    }),
    isNotFound: isVercelNotFound,
  });
  applyOwnedRecoveryEvidence(pathReport, recovery);
  return recovery;
}

async function runPath(config, fixture, label, runSignal, client, terminalAdapter) {
  const remote = normalizeGitHubSourceRemote(`https://github.com/${config.fixture.repository}.git`);
  const requestedBranch = label === 'existing' ? config.fixture.branch : createMissingBranch(config);
  const requestedBranchResponse = await githubJson(
    config,
    `/branches/${encodeURIComponent(requestedBranch)}`,
    runSignal,
    true,
  );
  const requestedBranchExists = requestedBranchResponse.exists;
  if (label === 'existing' && !requestedBranchExists) {
    throw new Error(`configured existing fixture branch is missing: ${config.fixture.branch}`);
  }
  if (label === 'missing' && requestedBranchExists) {
    throw new Error(`run-unique missing fixture branch already exists: ${requestedBranch}`);
  }
  const sourceRevision = requestedBranchExists ? requestedBranch : config.fixture.defaultBranch;
  const expectedSha = requestedBranchExists
    ? String(requestedBranchResponse.value?.commit?.sha ?? '')
    : fixture.defaultBranch.sha;
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) {
    throw new Error(`GitHub fixture did not provide a full commit SHA for ${sourceRevision}`);
  }

  const identity = createVercelIdentity({
    remote: remote.canonical,
    branch: requestedBranch,
    packageVersion: `provider-smoke-${runIdentity}-${label}`,
    scope: config.credentials,
  });
  const pathReport = createPathReport(label, requestedBranch, sourceRevision, identity);
  pathReport.fixtureRepository = remote.canonical;
  pathReport.scope = {
    teamId: config.credentials.teamId,
    projectId: config.credentials.projectId,
  };
  report.paths.push(pathReport);

  const smokeController = new AbortController();
  const smokeTimer = setTimeout(() => smokeController.abort(new Error(`provider smoke path ${label} exceeded its deadline`)), smokeTimeoutMs);
  const signal = combineSignals(runSignal, smokeController.signal);
  let sandbox;
  const credentials = config.credentials;
  try {
    const source = buildSource(config, remote, requestedBranch, sourceRevision, requestedBranchExists);
    const createRequest = buildVercelSandboxCreateRequest({
      name: identity.name,
      source: source.source,
      timeoutMs: smokeTimeoutMs,
      tags: { ...identity.tags },
      signal,
      onCreate: requestedBranchExists
        ? undefined
        : async (created) => {
          const switched = await client.runCommand(created, 'git', ['switch', '--create', requestedBranch, '--'], {
            signal,
            timeoutMs: commandTimeoutMs,
          });
          if (switched.exitCode !== 0) throw new Error(`requested missing branch creation failed with exit code ${switched.exitCode}`);
        },
    });
    sandbox = await timed(
      pathReport,
      'create',
      (requestSignal) => client.getOrCreate({ credentials, ...createRequest, signal: requestSignal }),
      signal,
      Math.min(operationTimeoutMs, smokeTimeoutMs),
    );
    recordCheck(pathReport, 'Sandbox image pin', sandbox.image === VERCEL_IMAGE_PIN.reference, 'created Sandbox reports the promoted image reference');
    recordCheck(pathReport, 'Sandbox scope identity', sandbox.tags?.identity === identity.tags.identity, 'created Sandbox returned the run-unique identity tags');

    await timed(
      pathReport,
      'clone',
      (requestSignal) => assertRepository(client, sandbox, config, pathReport, {
        remoteUrl: remote.url,
        sha: expectedSha,
        branch: requestedBranch,
      }, requestSignal),
      signal,
      Math.min(operationTimeoutMs * 2, smokeTimeoutMs),
    );
    await timed(pathReport, 'terminal-initial', (requestSignal) => runInteractiveTerminal(sandbox, pathReport, requestSignal, terminalAdapter), signal, terminalTimeoutMs);

    const initialStop = await timed(pathReport, 'stop-initial', (requestSignal) => client.stopSandbox(sandbox, { signal: requestSignal }), signal, operationTimeoutMs);
    recordCheck(pathReport, 'initial stop snapshot', Boolean(initialStop.snapshot?.id) && ['created', 'deleted'].includes(initialStop.snapshot.status), `snapshot status=${initialStop.snapshot?.status ?? 'missing'}`);
    const afterInitialStop = await client.listSessions(sandbox, { signal });
    pathReport.sessions.push({ phase: 'after-initial-stop', states: afterInitialStop.map(sessionState) });

    const resumed = await timed(pathReport, 'resume-attach', (requestSignal) => attachResumedSandbox(client, credentials, identity.name, requestSignal), signal, operationTimeoutMs);
    recordCheck(pathReport, 'resume/reconnect attach', resumed.status === 'running' || resumed.status === 'pending', `status=${resumed.status}`);
    await timed(pathReport, 'terminal-resumed', (requestSignal) => runInteractiveTerminal(resumed, pathReport, requestSignal, terminalAdapter), signal, terminalTimeoutMs);

    const finalStop = await timed(pathReport, 'stop-final', (requestSignal) => client.stopSandbox(resumed, { signal: requestSignal }), signal, operationTimeoutMs);
    recordCheck(pathReport, 'final stop snapshot', Boolean(finalStop.snapshot?.id) && ['created', 'deleted'].includes(finalStop.snapshot.status), `snapshot status=${finalStop.snapshot?.status ?? 'missing'}`);
    const finalSessions = await client.listSessions(resumed, { signal });
    pathReport.sessions.push({ phase: 'after-final-stop', states: finalSessions.map(sessionState) });
    pathReport.cleanup.finalSessionStatesTerminal = finalSessions.length > 0 && finalSessions.every((session) => ['stopped', 'aborted'].includes(session.status));
    recordCheck(pathReport, 'every created session terminal', pathReport.cleanup.finalSessionStatesTerminal, 'all listed sessions are stopped or aborted');
    pathReport.cleanup.stopped = pathReport.cleanup.finalSessionStatesTerminal;
    pathReport.knownSnapshotIds = [initialStop.snapshot?.id, finalStop.snapshot?.id].filter((value) => typeof value === 'string');

    const cleanupResult = await timed(pathReport, 'remove', (requestSignal) => cleanupVercelSandbox({
      name: identity.name,
      credentials,
      expectedTags: identity.tags,
      knownSnapshotIds: pathReport.knownSnapshotIds,
      adapter: cleanupAdapter(client),
      timeoutMs: cleanupTimeoutMs,
      maxAttempts: 8,
      signal: requestSignal,
    }), signal, cleanupTimeoutMs);
    applyCleanupResult(pathReport, cleanupResult);
  } catch (error) {
    pathReport.functionalFailed = true;
    pathReport.error = errorMessage(error);
  } finally {
    clearTimeout(smokeTimer);
    const cleanupController = new AbortController();
    const cleanupTimer = setTimeout(() => cleanupController.abort(new Error(`provider smoke cleanup exceeded ${cleanupTimeoutMs}ms`)), cleanupTimeoutMs);
    try {
      const recovery = await timed(
        pathReport,
        'snapshot-cleanup',
        (requestSignal) => recoverOwned(client, credentials, identity, pathReport, requestSignal),
        cleanupController.signal,
        cleanupTimeoutMs,
      );
      if (recovery.errors.length > 0) pathReport.cleanupFailed = true;
      if (recovery.errors.length === 0 && recovery.discoveryConverged && recovery.snapshotsCleaned) {
        pathReport.cleanup.stopped = pathReport.cleanup.stopped || pathReport.cleanup.finalSessionStatesTerminal;
        pathReport.cleanup.deleted = true;
        pathReport.cleanup.deletionVerified = true;
        pathReport.cleanup.noRunningSessionAfterDelete = true;
        pathReport.cleanup.discoveryConverged = true;
        pathReport.cleanup.snapshotsCleaned = true;
        pathReport.cleanup.errors = [];
        pathReport.cleanupFailed = false;
      }
    } catch (error) {
      pathReport.cleanup.errors.push(errorMessage(error));
      pathReport.cleanupFailed = true;
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
  pathReport.failed = pathReport.functionalFailed === true || pathReport.cleanupFailed === true;
  if (pathReport.failed) report.failed = true;
  if (pathReport.failed) throw new Error(`${label} provider smoke path failed`);
}

async function attachResumedSandbox(client, credentials, name, signal) {
  // This is the production client's attach/resume seam used by the provider.
  return client.get({ credentials, name, resume: true, signal });
}

function combineSignals(first, second) {
  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (first?.aborted) abort(first);
  if (second?.aborted) abort(second);
  first?.addEventListener('abort', () => abort(first), { once: true });
  second?.addEventListener('abort', () => abort(second), { once: true });
  return controller.signal;
}

function sessionState(session) {
  return {
    id: session.id,
    status: session.status,
  };
}

function applyCleanupResult(pathReport, result) {
  pathReport.cleanup.stopped = pathReport.cleanup.stopped || result.finalSessions.length > 0 && result.finalSessions.every((session) => ['stopped', 'aborted'].includes(session.status));
  pathReport.cleanup.deleted = result.sandboxDeleted;
  pathReport.cleanup.deletionVerified = result.verified;
  pathReport.cleanup.noRunningSessionAfterDelete = result.finalSessions.every((session) => ['stopped', 'aborted'].includes(session.status));
  pathReport.cleanup.snapshotsCleaned = result.snapshotsCleaned;
  pathReport.cleanup.residualNonDeletedSnapshots = result.residualSnapshotIds.map((id) => ({ id, status: 'residual' }));
  pathReport.snapshots.push(...result.snapshotIds.map((id) => ({ id, status: result.residualSnapshotIds.includes(id) ? 'created' : 'deleted' })));
  if (result.errors.length > 0) {
    pathReport.cleanup.recovery ??= [];
    pathReport.cleanup.recovery.push(...result.errors.map((detail) => ({
      operation: 'cleanup',
      outcome: 'pending-reconciliation',
      detail,
    })));
  }
  if (!result.verified || result.errors.length > 0) pathReport.cleanupFailed = true;
}

async function writeReport() {
  if (!reportPath) return;
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  let config;
  try {
    // This is intentionally the first provider-specific operation. A zero or
    // pending pin must fail before credentials or a cloud API are touched.
    const image = assertPromotedVercelImagePin(VERCEL_IMAGE_PIN);
    initializeSecretValues();
    report.image = {
      registry: image.registry,
      team: image.team,
      project: image.project,
      repository: image.repository,
      digest: image.digest,
    };
    config = parseVercelProviderSmokeConfig(process.env);
    report.configuration = {
      path: config.path,
      fixtureRepository: config.fixture.repository,
      fixtureBranch: config.fixture.branch,
      fixtureDefaultBranch: config.fixture.defaultBranch,
      expectedFile: config.fixture.expectedFile,
      scope: {
        teamId: config.credentials.teamId,
        projectId: config.credentials.projectId,
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`provider smoke exceeded ${smokeTimeoutMs}ms`)), smokeTimeoutMs);
    const client = createVercelSandboxClient({ sandbox: Sandbox, snapshot: Snapshot });
    const terminalAdapter = createVercelTerminalAdapter();
    try {
      const fixture = await timed(report, 'fixture-validation', (signal) => inspectFixture(config, signal), controller.signal, githubTimeoutMs * 3);
      report.fixture = fixture;
      const labels = config.path === 'both' ? ['existing', 'missing'] : [config.path];
      for (const label of labels) {
        try {
          await runPath(config, fixture, label, controller.signal, client, terminalAdapter);
        } catch (error) {
          report.failed = true;
          report.errors ??= [];
          report.errors.push(`${label}: ${errorMessage(error)}`);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    report.failed = true;
    report.blocked = errorMessage(error).includes('blocked until') || errorMessage(error).includes('unpromoted');
    report.error = errorMessage(error);
  } finally {
    if (report.paths.length > 0) {
      report.cleanup = {
        stopped: report.paths.every((path) => path.cleanup.stopped),
        deleted: report.paths.every((path) => path.cleanup.deleted),
        deletionVerified: report.paths.every((path) => path.cleanup.deletionVerified),
        noRunningSessionAfterDelete: report.paths.every((path) => path.cleanup.noRunningSessionAfterDelete),
        discoveryConverged: report.paths.every((path) => path.cleanup.discoveryConverged),
        snapshotsCleaned: report.paths.every((path) => path.cleanup.snapshotsCleaned),
        finalSessionStatesTerminal: report.paths.every((path) => path.cleanup.finalSessionStatesTerminal),
        residualNonDeletedSnapshots: report.paths.flatMap((path) => path.cleanup.residualNonDeletedSnapshots),
        errors: report.paths.flatMap((path) => path.cleanup.errors),
      };
    }
    await writeReport();
  }
  if (report.failed) {
    console.error(redactText(report.error ?? 'Vercel provider smoke failed; inspect the redacted evidence artifact.'));
    return 1;
  }
  console.error('Vercel provider smoke passed; inspect the redacted evidence artifact for detailed checks.');
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  report.failed = true;
  report.error = errorMessage(error);
  try {
    await writeReport();
  } catch {
    // The workflow will surface the process error; do not print credential data.
  }
  console.error(redactText(report.error));
  process.exitCode = 1;
}
