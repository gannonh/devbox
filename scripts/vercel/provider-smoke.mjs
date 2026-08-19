#!/usr/bin/env node
/**
 * Credentialed provider smoke for the production Vercel adapters.
 *
 * This script deliberately uses the pinned @vercel/sandbox v3 client and the
 * production terminal adapter. It never invokes the Vercel CLI, never places a
 * credential in argv, and writes only redaction-safe evidence.
 */
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  assertPromotedVercelImagePin,
  calculateVercelProviderSmokeBudget,
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
  createVercelRepositoryTag,
} from '../../dist/providers/vercel/identity.js';
import {
  matchesVercelSandboxImageDigest,
  VERCEL_IMAGE_PIN,
} from '../../dist/providers/vercel/image.js';
import {
  normalizeGitHubSourceRemote,
  resolveVercelRepositoryCwd,
} from '../../dist/providers/vercel/source.js';
import { createVercelTerminalAdapter } from '../../dist/providers/vercel/terminal.js';
import { boundedCall } from './sandbox-cleanup.mjs';
import {
  hasPreflightSandboxProof,
  isExactSmokeSandboxRecord,
  SMOKE_NAME_PREFIX,
  selectSmokeOwnedSandboxes,
} from './smoke-reconciliation.mjs';
import {
  applyOwnedRecoveryEvidence,
  recoverOwnedResources,
} from './sandbox-owned-recovery.mjs';
import { deleteListedSnapshot } from './snapshot-cleanup.mjs';
import { fetchWithTimeout } from './http-probe.mjs';
import { runInteractiveTerminal } from './smoke-terminal.mjs';
import { validateCloneBranchState } from './smoke-repository.mjs';
import {
  aggregateCleanupEvidence,
  createConfigurationEvidence,
  createEmptyCleanupEvidence,
  createEmptyPreflightEvidence,
  createFixtureEvidence,
  createPreflightEvidence,
  createPathReport,
  createRunIdentity,
  fingerprintEvidence,
  hasTerminalSessionProof,
  safeIdentityPart,
} from './smoke-evidence.mjs';

const startedAt = Date.now();
const reportPath = process.env.SMOKE_REPORT;
let secretValues = [];
const runIdentity = createRunIdentity();
const report = {
  schemaVersion: 1,
  redacted: false,
  failed: false,
  runIdentity,
  imageDigest: VERCEL_IMAGE_PIN.reference.split('@').at(-1),
  paths: [],
  cleanup: createEmptyCleanupEvidence(),
  preflight: createEmptyPreflightEvidence(),
  startedAt: new Date(startedAt).toISOString(),
};

const smokeTimeoutMs = positiveTimeout('SMOKE_TIMEOUT_MS', 12 * 60 * 1000);
const uatTimeoutMs = positiveTimeout('SMOKE_UAT_TIMEOUT_MS', smokeTimeoutMs);
const operationTimeoutMs = positiveTimeout('SMOKE_OPERATION_TIMEOUT_MS', 30_000);
const commandTimeoutMs = positiveTimeout('SMOKE_COMMAND_TIMEOUT_MS', 60_000);
const cleanupTimeoutMs = positiveTimeout('SMOKE_CLEANUP_TIMEOUT_MS', 120_000);
const terminalTimeoutMs = positiveTimeout('SMOKE_TERMINAL_TIMEOUT_MS', 90_000);
const githubTimeoutMs = positiveTimeout('SMOKE_GITHUB_TIMEOUT_MS', 10_000);
const fixtureValidationTimeoutMs = githubTimeoutMs * 3;
const uatRequired = process.env.DEVBOX_UAT_REQUIRED === 'true';
const UAT_FIXTURE_PATH = '/vercel/.devbox/runtime/uat-fixture.mjs';
const UAT_REFRESH_PATH = '/vercel/.devbox/runtime/uat-refresh';

function initializeSecretValues() {
  const sensitiveNames = /(?:TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|PRIVATE_KEY|TEAM_ID|PROJECT_ID|ENV_CONTENT|UAT_)|^DEVBOX_GITHUB_FIXTURE_/i;
  addSensitiveValues(Object.entries(process.env)
    .filter(([name, value]) => sensitiveNames.test(name)
      && typeof value === 'string'
      && value.length > 0
      && value !== 'true'
      && value !== 'false')
    .map(([, value]) => value));
}

function addSensitiveValues(values) {
  secretValues = [...new Set([
    ...secretValues,
    ...values.filter((value) => typeof value === 'string' && value.length > 0),
  ])];
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
  if (repository.private !== true) throw new Error('DEVBOX_GITHUB_FIXTURE_REPOSITORY must be private');
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

async function runCommand(client, sandbox, command, args, cwd, signal, timeoutMs = commandTimeoutMs) {
  const result = await client.runCommand(sandbox, {
    cmd: command,
    args,
    cwd,
    signal,
    timeoutMs,
  });
  const [stdout, stderr] = await Promise.all([
    result.stdout ? result.stdout({ signal }) : Promise.resolve(''),
    result.stderr ? result.stderr({ signal }) : Promise.resolve(''),
  ]);
  return { exitCode: result.exitCode, stdout, stderr };
}

async function runUatContract(client, sandbox, config, pathReport, cwd, signal, label) {
  const pushToken = config.fixture.token;
  const refreshValue = randomBytes(24).toString('hex');
  const envContent = `DEVBOX_UAT_PHASE=${label}\nDEVBOX_UAT_REFRESH=${refreshValue}\n`;
  const fixtureSource = await readFile(new URL('./uat-fixture.mjs', import.meta.url), 'utf8');
  addSensitiveValues([pushToken, envContent, refreshValue]);
  const previousRefresh = label === 'resume'
    ? await runCommand(client, sandbox, 'cat', [UAT_REFRESH_PATH], cwd, signal)
    : undefined;
  if (label === 'resume') {
    recordCheck(pathReport, 'resume runtime secret baseline', previousRefresh.exitCode === 0 && previousRefresh.stdout.trim().length > 0, `exitCode=${previousRefresh.exitCode}`);
  }
  const directories = await runCommand(
    client,
    sandbox,
    'mkdir',
    ['-p', '/vercel/.devbox/runtime'],
    cwd,
    signal,
  );
  recordCheck(pathReport, `${label} runtime directory`, directories.exitCode === 0, `exitCode=${directories.exitCode}`);
  await client.writeFiles(sandbox, [
    { path: '/vercel/.env', content: Buffer.from(envContent), mode: 0o600 },
    { path: '/vercel/.devbox/runtime/github-token', content: Buffer.from(pushToken), mode: 0o600 },
    { path: UAT_FIXTURE_PATH, content: Buffer.from(fixtureSource), mode: 0o700 },
  ], { signal });
  try {
    const auth = await runCommand(
      client,
      sandbox,
      'sh',
      ['-c', 'gh auth login --hostname github.com --with-token < /vercel/.devbox/runtime/github-token && gh auth setup-git --hostname github.com && rm -f /vercel/.devbox/runtime/github-token'],
      cwd,
      signal,
    );
    recordCheck(pathReport, `${label} runtime GitHub authentication`, auth.exitCode === 0, `exitCode=${auth.exitCode}`);
    const link = await runCommand(
      client,
      sandbox,
      'sh',
      ['-c', 'if [ -e .env ] && [ ! -L .env ]; then rm -f .env; fi; ln -sfn /vercel/.env .env'],
      cwd,
      signal,
    );
    recordCheck(pathReport, `${label} runtime configuration`, link.exitCode === 0, `exitCode=${link.exitCode}`);
    const result = await runCommand(client, sandbox, 'node', [UAT_FIXTURE_PATH, label], cwd, signal, smokeTimeoutMs);
    const markers = label === 'initial'
      ? [
        ['agents', 'DEVBOX_UAT:agents'],
        ['Chromium localhost OAuth', 'DEVBOX_UAT:chromium-oauth'],
        ['Electron/Vite', 'DEVBOX_UAT:electron-vite'],
        ['authenticated git push', 'DEVBOX_UAT:push'],
      ]
      : [['resume secret refresh', 'DEVBOX_UAT:resume-secret-refresh']];
    const outputLines = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()));
    const failed = [];
    for (const [name, marker] of markers) {
      const ok = result.exitCode === 0 && outputLines.has(marker);
      pathReport.checks.push({
        name: `${label} UAT ${name}`,
        ok,
        detail: result.exitCode === 0
          ? `exitCode=${result.exitCode}`
          : `exitCode=${result.exitCode}; ${redactText(result.stderr).trim().slice(0, 240)}`,
      });
      if (!ok) failed.push(name);
    }
    if (failed.length > 0) throw new Error(`${label} UAT checks failed: ${failed.join(', ')}`);
    if (label === 'resume') {
      const observedRefresh = /^DEVBOX_UAT_REFRESH=([A-Za-z0-9]+)$/m.exec(result.stdout)?.[1];
      const previousValue = previousRefresh.stdout.trim();
      recordCheck(
        pathReport,
        'resume runtime secret refresh observed',
        observedRefresh === refreshValue && previousValue.length > 0 && previousValue !== refreshValue,
        observedRefresh === refreshValue ? 'refreshed secret observed after resume' : 'refreshed secret was not observed after resume',
      );
    }
    await client.writeFiles(sandbox, [{ path: UAT_REFRESH_PATH, content: Buffer.from(refreshValue), mode: 0o600 }], { signal });
    pathReport.uat = { ...(pathReport.uat ?? {}), [`${label}Complete`]: true };
  } finally {
    try {
      await runCommand(
        client,
        sandbox,
        'sh',
        ['-c', `rm -f -- .env /vercel/.env ${UAT_FIXTURE_PATH} /vercel/.devbox/runtime/github-token`],
        cwd,
        signal,
      );
    } catch {
      // Sandbox deletion remains the authoritative cleanup path.
    }
  }
}

async function deleteUatBranch(config, branch, signal) {
  const token = config.fixture.token;
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${config.fixture.repository}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
      },
    },
    githubTimeoutMs,
    signal,
  );
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`GitHub fixture UAT branch cleanup returned HTTP ${response.status}`);
  }
  const verification = await githubJson(
    config,
    `/branches/${encodeURIComponent(branch)}`,
    signal,
    true,
  );
  if (verification.exists) throw new Error('GitHub fixture UAT branch cleanup was not verified');
}

async function assertRepository(client, sandbox, config, pathReport, expected, cwd, signal) {
  const remote = await runCommand(client, sandbox, 'git', ['remote', 'get-url', 'origin'], cwd, signal);
  recordCheck(pathReport, 'private clone remote', remote.exitCode === 0 && remote.stdout.trim() === expected.remoteUrl, `exitCode=${remote.exitCode}`);

  const head = await runCommand(client, sandbox, 'git', ['rev-parse', 'HEAD'], cwd, signal);
  recordCheck(pathReport, 'private clone requested revision HEAD', head.exitCode === 0 && /^[a-f0-9]{40}$/.test(head.stdout.trim()) && head.stdout.trim() === expected.sha, `exitCode=${head.exitCode}`);

  const branch = await runCommand(client, sandbox, 'git', ['branch', '--show-current'], cwd, signal);
  const branchState = validateCloneBranchState(branch.stdout, expected.branch, expected.allowDetachedBranch);
  const branchCheckName = expected.allowDetachedBranch
    ? 'private clone existing revision branch state'
    : 'private clone requested branch';
  recordCheck(pathReport, branchCheckName, branch.exitCode === 0 && branchState.ok, `observed=${branchState.state === 'detached' ? 'detached HEAD' : branchState.observedBranch}; expected=${expected.branch}`);

  const content = await runCommand(client, sandbox, 'cat', ['--', config.fixture.expectedFile], cwd, signal);
  recordCheck(pathReport, 'private clone expected content', content.exitCode === 0 && content.stdout === config.fixture.expectedContent, `exitCode=${content.exitCode}`);

  const status = await runCommand(client, sandbox, 'git', ['status', '--porcelain'], cwd, signal);
  recordCheck(pathReport, 'private clone clean worktree', status.exitCode === 0 && status.stdout.trim() === '', `exitCode=${status.exitCode}`);
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

async function preflightSmokeResources(config, client, signal) {
  const remote = normalizeGitHubSourceRemote(`https://github.com/${config.fixture.repository}.git`);
  const repositoryTag = createVercelRepositoryTag(remote.canonical);
  const adapter = cleanupAdapter(client);
  const discovered = [];
  const ignored = [];
  const cleaned = [];
  const cleanupResults = new Map();
  const residual = [];
  const errors = [];
  let cleanupFailures = 0;
  let firstListingSucceeded = false;
  let finalListingSucceeded = false;
  let sessionProofCount = 0;
  let snapshotsCleanedCount = 0;

  const addError = (error) => {
    const detail = errorMessage(error);
    if (!errors.includes(detail)) errors.push(detail);
  };
  const listCandidates = async () => {
    const records = await client.listSandboxes({
      credentials: config.credentials,
      namePrefix: SMOKE_NAME_PREFIX,
      signal,
    });
    return { ...selectSmokeOwnedSandboxes(records, repositoryTag), records };
  };

  try {
    const selection = await listCandidates();
    firstListingSucceeded = true;
    ignored.push(...selection.ignored);
    for (const sandbox of selection.owned) {
      discovered.push(sandbox.name);
      addSensitiveValues([sandbox.name, ...Object.values(sandbox.tags ?? {})]);
      try {
        const result = await cleanupVercelSandbox({
          name: sandbox.name,
          credentials: config.credentials,
          expectedTags: sandbox.tags,
          knownSnapshotIds: sandbox.currentSnapshotId === undefined ? [] : [sandbox.currentSnapshotId],
          adapter,
          timeoutMs: cleanupTimeoutMs,
          maxAttempts: 8,
          signal,
        });
        addSensitiveValues(result.snapshotIds);
        if (result.snapshotsCleaned) snapshotsCleanedCount += 1;
        if (result.verified && result.errors.length === 0) {
          cleanupResults.set(sandbox.name, { result, status: sandbox.status });
        } else {
          cleanupFailures += 1;
          residual.push({ name: sandbox.name, status: sandbox.status });
          addError(`preflight cleanup for ${sandbox.name} did not prove absence and terminal sessions`);
          for (const detail of result.errors) addError(detail);
        }
      } catch (error) {
        cleanupFailures += 1;
        residual.push({ name: sandbox.name, status: sandbox.status });
        addError(`preflight cleanup for ${sandbox.name}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    addError(`preflight sandbox discovery: ${errorMessage(error)}`);
  }

  let finalOwned = [];
  let finalRecords = [];
  let finalExactNames = [];
  if (firstListingSucceeded) {
    try {
      const finalSelection = await listCandidates();
      finalListingSucceeded = true;
      ignored.push(...finalSelection.ignored);
      finalOwned = finalSelection.owned;
      finalRecords = finalSelection.records;
      finalExactNames = finalRecords.filter((sandbox) => typeof sandbox?.name === 'string' && discovered.includes(sandbox.name));
      residual.push(...finalOwned.map((sandbox) => ({ name: sandbox.name, status: sandbox.status })));
      residual.push(...finalExactNames
        .filter((sandbox) => !finalOwned.some((owned) => owned.name === sandbox.name))
        .map((sandbox) => ({ name: sandbox.name, status: sandbox.status })));
      if (finalOwned.length > 0 || finalExactNames.length > 0) addError('preflight sandbox discovery still contains smoke-owned resources');
    } catch (error) {
      addError(`preflight final sandbox discovery: ${errorMessage(error)}`);
    }
  }

  for (const [name, { result, status }] of cleanupResults) {
    const proved = hasPreflightSandboxProof({
      cleanupResult: result,
      expectedName: name,
      finalListingSucceeded,
      finalRecords,
      sessionProof: hasTerminalSessionProof(result.finalSessions),
    });
    if (proved) {
      cleaned.push(name);
      sessionProofCount += 1;
    } else {
      cleanupFailures += 1;
      if (finalListingSucceeded && !finalRecords.some((sandbox) => isExactSmokeSandboxRecord(sandbox, name))) {
        residual.push({ name, status });
      }
      addError(`preflight cleanup for ${name} did not prove absence and terminal sessions`);
      for (const detail of result.errors) addError(detail);
    }
  }

  const evidence = createPreflightEvidence({
    namePrefix: SMOKE_NAME_PREFIX,
    repositoryTag,
    discovered,
    ignored: [...new Set(ignored.map((sandbox) => sandbox.name))],
    cleaned,
    residual,
    discoveryConverged: finalListingSucceeded && finalOwned.length === 0 && finalExactNames.length === 0,
    snapshotsCleaned: discovered.length === 0 || snapshotsCleanedCount === discovered.length,
    sessionProof: discovered.length > 0 && sessionProofCount === discovered.length,
    errors,
    redact: errorMessage,
  });
  const success = firstListingSucceeded && finalListingSucceeded && finalOwned.length === 0 && finalExactNames.length === 0 && cleanupFailures === 0;
  return { success, evidence };
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
    recoverSandbox: async (name, { signal: requestSignal, sandbox }) => {
      if (!sandbox || sandbox.name !== identity.name) {
        throw new Error('owned Sandbox listing did not match the current path identity');
      }
      const result = await cleanupVercelSandbox({
        name,
        credentials,
        expectedTags: identity.tags,
        adapter,
        timeoutMs: Math.min(cleanupTimeoutMs, operationTimeoutMs * 4),
        maxAttempts: 4,
        signal: requestSignal,
      });
      pathReport.sessions.push({
        phase: 'recovery',
        sandboxNameFingerprint: fingerprintEvidence(name),
        states: result.finalSessions.map(sessionState),
      });
      const sessionProof = hasTerminalSessionProof(result.finalSessions);
      if (sessionProof) pathReport.cleanup.finalSessionStatesTerminal = true;
      if (!result.verified) throw new Error(`owned Sandbox ${name} cleanup did not converge`);
      return { sessionProof };
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
  applyOwnedRecoveryEvidence(pathReport, recovery, errorMessage);
  return recovery;
}

async function runPath(config, fixture, label, runSignal, client, terminalAdapter, pathTimeoutMs) {
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
  addSensitiveValues([
    remote.canonical,
    remote.url,
    requestedBranch,
    sourceRevision,
    identity.name,
    ...Object.values(identity.tags),
  ]);
  const pathReport = createPathReport({
    label,
    requestedBranch,
    sourceRevision,
    identity,
    credentials: config.credentials,
  });
  report.paths.push(pathReport);

  const smokeController = new AbortController();
  const smokeTimer = setTimeout(() => smokeController.abort(new Error(`provider smoke path ${label} exceeded its deadline`)), pathTimeoutMs);
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
          const switched = await client.runCommand(created, {
            cmd: 'git',
            args: ['switch', '--create', requestedBranch, '--'],
            cwd: resolveVercelRepositoryCwd(created.cwd, remote.repository),
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
      smokeTimeoutMs,
    );
    const expectedImageDigest = VERCEL_IMAGE_PIN.reference.split('@').at(-1);
    recordCheck(pathReport, 'Sandbox image pin', matchesVercelSandboxImageDigest(sandbox.image, expectedImageDigest), 'created Sandbox reports the expected promoted image digest');
    recordCheck(pathReport, 'Sandbox scope identity', sandbox.tags?.identity === identity.tags.identity, 'created Sandbox returned the run-unique identity tags');

    const cloneCwd = resolveVercelRepositoryCwd(sandbox.cwd, remote.repository);
    await timed(
      pathReport,
      'clone',
      (requestSignal) => assertRepository(client, sandbox, config, pathReport, {
        remoteUrl: remote.url,
        sha: expectedSha,
        branch: requestedBranch,
        allowDetachedBranch: requestedBranchExists,
      }, cloneCwd, requestSignal),
      signal,
      Math.min(operationTimeoutMs * 2, smokeTimeoutMs),
    );
    await timed(
      pathReport,
      'terminal-initial',
      (requestSignal) => runInteractiveTerminal({
        sandbox,
        pathReport,
        signal: requestSignal,
        terminalAdapter,
        cloneCwd,
        terminalTimeoutMs,
        recordCheck,
      }),
      signal,
      terminalTimeoutMs,
    );
    if (uatRequired && label === 'missing') {
      await timed(
        pathReport,
        'uat-contract',
        (requestSignal) => runUatContract(
          client,
          sandbox,
          config,
          pathReport,
          cloneCwd,
          requestSignal,
          'initial',
        ),
        signal,
        smokeTimeoutMs,
      );
    }

    const initialStop = await timed(pathReport, 'stop-initial', (requestSignal) => client.stopSandbox(sandbox, { signal: requestSignal }), signal, operationTimeoutMs);
    recordCheck(pathReport, 'initial stop snapshot', Boolean(initialStop.snapshot?.id) && ['created', 'deleted'].includes(initialStop.snapshot.status), `snapshot status=${initialStop.snapshot?.status ?? 'missing'}`);
    const afterInitialStop = await client.listSessions(sandbox, { signal });
    pathReport.sessions.push({ phase: 'after-initial-stop', states: afterInitialStop.map(sessionState) });

    const resumed = await timed(pathReport, 'resume-attach', (requestSignal) => attachResumedSandbox(client, credentials, identity.name, requestSignal), signal, operationTimeoutMs);
    recordCheck(pathReport, 'resume/reconnect attach', resumed.status === 'running' || resumed.status === 'pending', `status=${resumed.status}`);
    const resumedCloneCwd = resolveVercelRepositoryCwd(resumed.cwd, remote.repository);
    await timed(
      pathReport,
      'terminal-resumed',
      (requestSignal) => runInteractiveTerminal({
        sandbox: resumed,
        pathReport,
        signal: requestSignal,
        terminalAdapter,
        cloneCwd: resumedCloneCwd,
        terminalTimeoutMs,
        recordCheck,
      }),
      signal,
      terminalTimeoutMs,
    );
    if (uatRequired && label === 'missing') {
      await timed(
        pathReport,
        'uat-resume-refresh',
        (requestSignal) => runUatContract(
          client,
          resumed,
          config,
          pathReport,
          resumedCloneCwd,
          requestSignal,
          'resume',
        ),
        signal,
        smokeTimeoutMs,
      );
    }

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
    const cleanupSignal = combineSignals(runSignal, cleanupController.signal);
    const cleanupTimer = setTimeout(() => cleanupController.abort(new Error(`provider smoke cleanup exceeded ${cleanupTimeoutMs}ms`)), cleanupTimeoutMs);
    try {
      const directCleanup = await timed(
        pathReport,
        'direct-cleanup',
        (requestSignal) => cleanupVercelSandbox({
          name: sandbox?.name ?? identity.name,
          credentials,
          expectedTags: identity.tags,
          knownSnapshotIds: pathReport.knownSnapshotIds ?? [],
          adapter: cleanupAdapter(client),
          timeoutMs: cleanupTimeoutMs,
          maxAttempts: 8,
          signal: requestSignal,
        }),
        cleanupSignal,
        cleanupTimeoutMs,
      );
      applyCleanupResult(pathReport, directCleanup);
      const directSessionProof = pathReport.cleanup.finalSessionStatesTerminal === true || hasTerminalSessionProof(directCleanup.finalSessions);
      if (!directCleanup.verified || directCleanup.errors.length > 0 || !directSessionProof) {
        pathReport.cleanupFailed = true;
        if (!directSessionProof) pathReport.cleanup.errors.push('direct cleanup session proof was not observed');
      }
    } catch (error) {
      pathReport.cleanup.errors.push(`direct cleanup: ${errorMessage(error)}`);
      pathReport.cleanupFailed = true;
    }
    try {
      const recovery = await timed(
        pathReport,
        'snapshot-cleanup',
        (requestSignal) => recoverOwned(client, credentials, identity, pathReport, requestSignal),
        cleanupSignal,
        cleanupTimeoutMs,
      );
      const sessionProof = pathReport.cleanup.finalSessionStatesTerminal === true || recovery.sessionProof === true;
      if (recovery.errors.length > 0) pathReport.cleanupFailed = true;
      if (recovery.errors.length === 0 && recovery.discoveryConverged && recovery.snapshotsCleaned && sessionProof) {
        pathReport.cleanup.stopped = true;
        pathReport.cleanup.deleted = true;
        pathReport.cleanup.deletionVerified = true;
        pathReport.cleanup.noRunningSessionAfterDelete = true;
        pathReport.cleanup.discoveryConverged = true;
        pathReport.cleanup.snapshotsCleaned = true;
        // Do not clear cleanup.errors or cleanupFailed: prior failures remain
        // part of the reconciliation history and still fail the aggregate.
      } else {
        pathReport.cleanupFailed = true;
        if (!sessionProof) {
          pathReport.cleanup.errors.push('cleanup session proof was not observed; empty discovery is insufficient');
        }
      }
    } catch (error) {
      pathReport.cleanup.errors.push(errorMessage(error));
      pathReport.cleanupFailed = true;
    } finally {
      clearTimeout(cleanupTimer);
    }
    if (uatRequired && label === 'missing') {
      const branchController = new AbortController();
      const branchTimer = setTimeout(() => branchController.abort(new Error('UAT branch cleanup exceeded its deadline')), githubTimeoutMs * 3);
      try {
        await deleteUatBranch(config, requestedBranch, branchController.signal);
        pathReport.uat = { ...(pathReport.uat ?? {}), pushedBranchDeleted: true };
      } catch (error) {
        pathReport.cleanup.errors.push(`UAT branch cleanup: ${errorMessage(error)}`);
        pathReport.cleanupFailed = true;
      } finally {
        clearTimeout(branchTimer);
      }
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
  const sessionProof = pathReport.cleanup.finalSessionStatesTerminal === true || hasTerminalSessionProof(result.finalSessions);
  pathReport.cleanup.finalSessionStatesTerminal = sessionProof;
  pathReport.cleanup.stopped = pathReport.cleanup.stopped || sessionProof;
  pathReport.cleanup.deleted = result.sandboxDeleted;
  pathReport.cleanup.deletionVerified = result.verified;
  pathReport.cleanup.noRunningSessionAfterDelete = sessionProof && result.sandboxDeleted;
  pathReport.cleanup.snapshotsCleaned = result.snapshotsCleaned;
  pathReport.cleanup.residualNonDeletedSnapshots = result.residualSnapshotIds.map((id) => ({ id, status: 'residual' }));
  pathReport.snapshots.push(...result.snapshotIds.map((id) => ({ id, status: result.residualSnapshotIds.includes(id) ? 'created' : 'deleted' })));
  if (result.errors.length > 0) {
    pathReport.cleanup.recovery ??= [];
    pathReport.cleanup.recovery.push(...result.errors.map((detail) => ({
      operation: 'cleanup',
      outcome: 'pending-reconciliation',
      detail: errorMessage(detail),
    })));
  }
  if (!result.verified || result.errors.length > 0 || !sessionProof) pathReport.cleanupFailed = true;
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
    // This is intentionally the first provider-specific operation. An invalid
    // pin must fail before credentials or a cloud API are touched.
    const image = assertPromotedVercelImagePin(VERCEL_IMAGE_PIN);
    initializeSecretValues();
    report.image = { digest: image.digest };
    config = parseVercelProviderSmokeConfig(process.env);
    if (uatRequired && config.path !== 'both') {
      throw new Error('provider UAT requires both existing and missing private-repository paths');
    }
    const smokeBudget = calculateVercelProviderSmokeBudget(
      config.path,
      smokeTimeoutMs,
      cleanupTimeoutMs,
      fixtureValidationTimeoutMs,
      githubTimeoutMs,
      undefined,
      uatRequired ? uatTimeoutMs : 0,
    );
    const outerTimeoutMs = positiveTimeout('SMOKE_TOTAL_TIMEOUT_MS', smokeBudget.outerTimeoutMs);
    if (outerTimeoutMs < smokeBudget.outerTimeoutMs) {
      throw new Error(`SMOKE_TOTAL_TIMEOUT_MS must cover the configured sequential smoke budget (${smokeBudget.outerTimeoutMs}ms)`);
    }
    report.configuration = createConfigurationEvidence(config, smokeBudget);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`provider smoke exceeded ${outerTimeoutMs}ms`)), outerTimeoutMs);
    const client = createVercelSandboxClient({ sandbox: Sandbox, snapshot: Snapshot });
    const terminalAdapter = createVercelTerminalAdapter();
    try {
      const fixture = await timed(report, 'fixture-validation', (signal) => inspectFixture(config, signal), controller.signal, smokeBudget.fixtureTimeoutMs);
      report.fixture = createFixtureEvidence(config, fixture);
      const preflight = await timed(
        report,
        'preflight-cleanup',
        (signal) => preflightSmokeResources(config, client, signal),
        controller.signal,
        cleanupTimeoutMs,
      );
      report.preflight = preflight.evidence;
      if (!preflight.success) throw new Error('provider smoke preflight cleanup did not converge');
      const labels = config.path === 'both' ? ['existing', 'missing'] : [config.path];
      for (const label of labels) {
        const pathTimeoutMs = smokeTimeoutMs + (uatRequired && label === 'missing' ? uatTimeoutMs : 0);
        try {
          await runPath(config, fixture, label, controller.signal, client, terminalAdapter, pathTimeoutMs);
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
      report.cleanup = aggregateCleanupEvidence(report.paths);
      if (!report.cleanup.processSuccess) report.failed = true;
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
