#!/usr/bin/env node
/**
 * Real Vercel Sandbox smoke gate for one credential scope.
 *
 * The publisher and consumer jobs invoke this script independently. It never
 * prints token/password values and always attempts to stop/delete the Sandbox,
 * verify terminal VM sessions, then clean up matching snapshots.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { APIError, Sandbox, Snapshot } from '@vercel/sandbox';
import {
  parseFullyQualifiedVcrReference,
  REQUIRED_SMOKE_CHECKS,
} from './smoke-contract.mjs';
import { fetchWithTimeout } from './http-probe.mjs';
import { TERMINAL_SESSION_STATES, verifySandboxDeleted, boundedCall } from './sandbox-cleanup.mjs';
import {
  applyOwnedRecoveryEvidence,
  recoverOwnedResources,
} from './sandbox-owned-recovery.mjs';
import { deleteListedSnapshot } from './snapshot-cleanup.mjs';

const role = process.env.SMOKE_ROLE;
const image = process.env.IMAGE_REF;
const expectedDigest = process.env.EXPECTED_IMAGE_DIGEST;
const reportPath = process.env.SMOKE_REPORT;
const smokeUrl = process.env.SMOKE_URL ?? '';
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID;
const token = process.env.VERCEL_TOKEN;
if (!role || !image || !expectedDigest || !projectId || !teamId || !token || !reportPath) {
  throw new Error('SMOKE_ROLE, IMAGE_REF, EXPECTED_IMAGE_DIGEST, VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID, and SMOKE_REPORT are required');
}
if (!['publisher', 'consumer'].includes(role)) throw new Error('SMOKE_ROLE must be publisher or consumer');
if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('EXPECTED_IMAGE_DIGEST must be a full sha256 digest');

function positiveTimeout(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return Math.ceil(value);
}

const smokeTimeoutMs = positiveTimeout('SMOKE_TIMEOUT_MS', 10 * 60 * 1000);
const sdkTimeoutMs = positiveTimeout('SMOKE_SDK_TIMEOUT_MS', 30_000);
const commandTimeoutMs = positiveTimeout('SMOKE_COMMAND_TIMEOUT_MS', 60_000);
const httpTimeoutMs = positiveTimeout('SMOKE_HTTP_TIMEOUT_MS', 10_000);
const cleanupTimeoutMs = positiveTimeout('SMOKE_CLEANUP_TIMEOUT_MS', 120_000);
const deleteVerifyTimeoutMs = positiveTimeout('SMOKE_DELETE_VERIFY_TIMEOUT_MS', 30_000);
const imageInfo = parseFullyQualifiedVcrReference(image);
if (imageInfo.digest !== expectedDigest) {
  throw new Error('Sandbox smoke must use the exact candidate digest, not a tag or different reference');
}
if (process.env.EXPECTED_IMAGE_TEAM_SLUG && imageInfo.team !== process.env.EXPECTED_IMAGE_TEAM_SLUG) {
  throw new Error('Sandbox smoke image team does not match the expected publisher scope');
}
if (process.env.EXPECTED_IMAGE_PROJECT_SLUG && imageInfo.project !== process.env.EXPECTED_IMAGE_PROJECT_SLUG) {
  throw new Error('Sandbox smoke image project does not match the expected publisher scope');
}

const credentials = { token, teamId, projectId };
const startedAtMs = Date.now();
const smokeDeadlineAt = startedAtMs + smokeTimeoutMs;
const smokeController = new AbortController();
const smokeDeadlineTimer = setTimeout(() => {
  smokeController.abort(new Error(`smoke deadline exceeded after ${smokeTimeoutMs}ms`));
}, smokeTimeoutMs);
const smokeSignal = smokeController.signal;
const password = randomBytes(24).toString('base64url');
const ownedId = randomBytes(12).toString('hex');
const ownedName = `devbox-smoke-${role}-${ownedId}`;
const ownedTag = `smoke-${role}-${ownedId}`;
const username = 'devbox-smoke';
const report = {
  redacted: false,
  role,
  scope: { teamId, projectId },
  imageReference: image,
  expectedDigest,
  smokeUrl,
  ownedName,
  ownedTag,
  startedAt: new Date(startedAtMs).toISOString(),
  checks: [],
  timings: {},
  sessionStates: [],
  snapshots: [],
  cleanup: {
    stopped: false,
    deleted: false,
    deletionVerified: false,
    discoveryConverged: false,
    snapshotsCleaned: false,
    noRunningSessionAfterDelete: false,
    residualNonDeletedSnapshots: [],
    errors: [],
  },
};
let sandbox;

function recordCheck(name, ok, detail = '') {
  report.checks.push({ name, ok, detail: String(detail).slice(0, 500) });
  return ok;
}

function check(name, ok, detail = '') {
  if (!recordCheck(name, ok, detail)) throw new Error(`${name} failed`);
}

async function bounded(label, operation, signal, timeoutMs) {
  if (signal?.aborted) throw signal.reason ?? new Error(`${label} was aborted`);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const operationResult = Promise.resolve().then(() => operation(controller.signal));
  const abortListener = () => rejectAbort(signal.reason ?? new Error(`${label} was aborted`));
  signal?.addEventListener('abort', abortListener, { once: true });
  try {
    return await Promise.race([operationResult, aborted, timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', abortListener);
  }
}

async function timed(stage, operation, options = {}) {
  const startedStageAtMs = Date.now();
  const timing = {
    startedAt: new Date(startedStageAtMs).toISOString(),
    startedEpochMs: startedStageAtMs,
  };
  report.timings[stage] = timing;
  const signal = options.signal ?? smokeSignal;
  const requestedTimeoutMs = options.timeoutMs ?? sdkTimeoutMs;
  const remainingSmokeMs = Math.max(1, smokeDeadlineAt - Date.now());
  const timeoutMs = options.respectSmokeDeadline === false
    ? requestedTimeoutMs
    : Math.min(requestedTimeoutMs, remainingSmokeMs);
  try {
    const result = await bounded(stage, operation, signal, timeoutMs);
    const finishedStageAtMs = Date.now();
    Object.assign(timing, {
      finishedAt: new Date(finishedStageAtMs).toISOString(),
      finishedEpochMs: finishedStageAtMs,
      durationMs: finishedStageAtMs - startedStageAtMs,
      outcome: 'passed',
    });
    return result;
  } catch (error) {
    const finishedStageAtMs = Date.now();
    Object.assign(timing, {
      finishedAt: new Date(finishedStageAtMs).toISOString(),
      finishedEpochMs: finishedStageAtMs,
      durationMs: finishedStageAtMs - startedStageAtMs,
      outcome: 'failed',
    });
    throw error;
  }
}

async function command(cmd, args = [], options = {}) {
  const { timeoutMs = commandTimeoutMs, ...commandOptions } = options;
  const operationTimeoutMs = Math.min(timeoutMs, Math.max(1, smokeDeadlineAt - Date.now()));
  const result = await bounded(
    `command ${cmd}`,
    (signal) => sandbox.runCommand({ cmd, args, ...commandOptions, signal, timeoutMs }),
    smokeSignal,
    operationTimeoutMs,
  );
  const stdout = await bounded(
    `command ${cmd} stdout`,
    (signal) => result.stdout({ signal }),
    smokeSignal,
    operationTimeoutMs,
  );
  const stderr = await bounded(
    `command ${cmd} stderr`,
    (signal) => result.stderr({ signal }),
    smokeSignal,
    operationTimeoutMs,
  );
  return { exitCode: result.exitCode, stdout, stderr };
}

function probeWebSocket(url, cookie, { signal = smokeSignal, timeoutMs = httpTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL('/websockify', url);
    const secure = target.protocol === 'https:';
    const socket = secure
      ? tls.connect({ host: target.hostname, port: Number(target.port || 443), servername: target.hostname })
      : net.connect(Number(target.port || 80), target.hostname);
    const key = randomBytes(16).toString('base64');
    let response = '';
    let settled = false;
    const abort = () => finish(signal.reason ?? new Error('WebSocket probe aborted'));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`WebSocket probe timed out after ${timeoutMs}ms`)));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', (error) => finish(error));
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write([
        'GET /websockify HTTP/1.1',
        `Host: ${target.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Cookie: ${cookie}`,
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (response.includes('\r\n\r\n')) finish(null, response.split('\r\n', 1)[0]);
    });
  });
}

async function listSnapshots(signal, targetName = sandbox.name) {
  const result = await Snapshot.list({ ...credentials, name: targetName, limit: 50, signal });
  return result.toArray();
}


async function listSessions(phase, target = sandbox, signal, record = true) {
  const result = await target.listSessions({ limit: 50, sortOrder: 'asc', signal });
  const sessions = await result.toArray();
  const states = sessions.map((session) => ({
    id: session.id,
    status: session.status,
    observedAt: new Date().toISOString(),
  }));
  if (record) report.sessionStates.push({ phase, states });
  else (report.cleanup.ownedSessionStates ??= []).push({ phase, states });
  return states;
}

function isNotFound(error) {
  return error instanceof APIError && [404, 410].includes(error.response.status);
}

function isTransientCleanupError(error) {
  return error instanceof APIError && [409, 422].includes(error.response.status) &&
    ['sandbox_stopping', 'sandbox_snapshotting'].includes(error.json?.error?.code);
}

async function verifyDeleted(name, signal, record = true) {
  const recoveryEvents = [];
  const result = await verifySandboxDeleted({
    timeoutMs: deleteVerifyTimeoutMs,
    operationTimeoutMs: sdkTimeoutMs,
    signal,
    getSandbox: (options) => Sandbox.get({ ...credentials, name, ...options }),
    listSessions: (target, options) => listSessions(options.phase ?? 'after-delete-lookup', target, options.signal, record),
    stopSandbox: (target, options) => target.stop(options),
    deleteSandbox: (target, options) => target.delete(options),
    isNotFound,
    isTransient: isTransientCleanupError,
    onMissing: (phase) => {
      report.sessionStates.push({ phase, states: [] });
    },
    onRecovery: (event) => {
      recoveryEvents.push(event);
    },
  });
  if (recoveryEvents.length > 0) {
    report.cleanup.recovery ??= [];
    report.cleanup.recovery.push(...recoveryEvents);
  }
  if (result.errors.length > 0) {
    report.cleanup.errors ??= [];
    report.cleanup.errors.push(...result.errors);
  }
  return result;
}

async function recoverOwned(signal) {
  const recovery = await recoverOwnedResources({
    timeoutMs: cleanupTimeoutMs,
    operationTimeoutMs: sdkTimeoutMs,
    listSandboxes: ({ signal: requestSignal }) => boundedCall(
      (innerSignal) => Sandbox.list({ ...credentials, namePrefix: ownedName, sortBy: 'name', tags: { 'devbox-run': ownedTag }, signal: innerSignal })
        .then((page) => page.toArray())
        .then((sandboxes) => sandboxes.filter((item) => item.name === ownedName)),
      'owned smoke Sandbox discovery',
      { signal: requestSignal, timeoutMs: sdkTimeoutMs },
    ),
    recoverSandbox: async (name, { signal: requestSignal }) => {
      const result = await verifyDeleted(name, requestSignal, false);
      if (!result.verified || !result.noRunningSession) throw new Error(`owned Sandbox ${name} was not fully deleted`);
    },
    listSnapshots: ({ signal: requestSignal }) => boundedCall(
      (innerSignal) => Snapshot.list({ ...credentials, name: ownedName, limit: 50, signal: innerSignal }).then((page) => page.toArray()),
      'owned smoke snapshot discovery',
      { signal: requestSignal, timeoutMs: sdkTimeoutMs },
    ),
    deleteSnapshot: (snapshot, { signal: requestSignal }) => deleteListedSnapshot({
      snapshot,
      signal: requestSignal,
      timeoutMs: sdkTimeoutMs,
      label: 'owned smoke snapshot',
      getSnapshot: (snapshotId, getSignal) => Snapshot.get({ ...credentials, snapshotId, signal: getSignal }),
    }),
    signal,
    isNotFound,
  });
  applyOwnedRecoveryEvidence(report, recovery);
  return recovery;
}

function finalSessionStatesAreTerminal() {
  const finalObservation = report.sessionStates.at(-1);
  if (!finalObservation) return false;
  if (finalObservation.phase === 'after-delete-missing' && finalObservation.states.length === 0) {
    const lastTerminalObservation = [...report.sessionStates].reverse().find((observation) =>
      observation.states.length > 0 && observation.states.every((session) => TERMINAL_SESSION_STATES.has(session.status)),
    );
    return Boolean(lastTerminalObservation);
  }
  return finalObservation.states.length > 0 && finalObservation.states.every((session) => TERMINAL_SESSION_STATES.has(session.status));
}

function recordRecoverableCleanupIssue(operation, detail) {
  report.cleanup.recovery ??= [];
  report.cleanup.recovery.push({ operation, outcome: 'pending-reconciliation', detail: String(detail).slice(0, 500) });
}

function markCleanupFailure(name, detail) {
  report.cleanup[name] = false;
  report.cleanup.errors ??= [];
  report.cleanup.errors.push(String(detail).slice(0, 500));
  report.failed = true;
}

try {
  sandbox = await timed('create', (signal) => Sandbox.create({
    ...credentials,
    image,
    name: ownedName,
    ports: [6081],
    persistent: false,
    timeout: 10 * 60 * 1000,
    tags: { 'devbox-image': `smoke-${role}`, 'devbox-run': ownedTag },
    signal,
  }), { timeoutMs: smokeTimeoutMs });
  report.sandboxName = sandbox.name;
  await timed('session-create', (signal) => listSessions('created', sandbox, signal));
  check('image digest', sandbox.image?.endsWith(`@${expectedDigest}`), 'Sandbox resolved the candidate digest');

  const identity = await command('id', ['-u']);
  check('non-root user', identity.exitCode === 0 && identity.stdout.trim() !== '0', identity.stdout.trim());
  const usernameResult = await command('id', ['-un']);
  check('expected non-root identity', usernameResult.exitCode === 0 && usernameResult.stdout.trim() !== 'root', usernameResult.stdout.trim());
  const sudo = await command('sudo', ['-n', 'true']);
  check('passwordless sudo', sudo.exitCode === 0);

  const binaryProbes = [
    'pi --version',
    'claude --version',
    'codex --version',
    'opencode --version',
    'gh --version',
    'node --version',
    'bun --version',
    'python --version',
    'chromium --version',
    'Xvfb -help',
    'fluxbox --version',
    'x11vnc -version',
    'websockify --help',
  ].map((probe) => probe.split(' '));
  let binaryProbesPassed = true;
  for (const [binary, versionFlag] of binaryProbes) {
    try {
      const probe = await command(binary, [versionFlag]);
      binaryProbesPassed = recordCheck(
        `binary ${binary}`,
        probe.exitCode === 0,
        `${probe.stdout}\n${probe.stderr}`.trim(),
      ) && binaryProbesPassed;
    } catch (error) {
      binaryProbesPassed = recordCheck(
        `binary ${binary}`,
        false,
        error instanceof Error ? error.message : error,
      ) && binaryProbesPassed;
    }
  }
  if (!binaryProbesPassed) throw new Error('one or more working-binary probes failed');

  const startResult = await timed('startup', async (signal) => {
    const start = await sandbox.runCommand({
      cmd: '/usr/local/bin/devbox-start',
      env: { DEVBOX_NOVNC_USER: username, DEVBOX_NOVNC_PASSWORD: password },
      detached: true,
      signal,
      timeoutMs: commandTimeoutMs,
    });
    return start.wait({ signal });
  }, { timeoutMs: commandTimeoutMs });
  check('explicit startup', startResult.exitCode === 0, 'startup command completed');

  const status = await command('/usr/local/bin/devbox-status');
  const requiredProcesses = ['Xvfb=running', 'fluxbox=running', 'x11vnc=running', 'websockify=running', 'auth-proxy=running'];
  check(
    'display and proxy processes',
    status.exitCode === 0 && requiredProcesses.every((process) => status.stdout.includes(process)),
    `${status.stdout}\n${status.stderr}`,
  );

  const domain = sandbox.domain(6081);
  report.noVncUrl = domain;
  const cookie = `devbox_novnc=${encodeURIComponent(password)}`;
  await timed('http', async (signal) => {
    const unpaired = await fetchWithTimeout(`${domain}/vnc.html`, {}, httpTimeoutMs, signal);
    check('noVNC rejects unauthenticated HTTP', unpaired.status === 200 && (await unpaired.text()).includes('name="token"'), `status=${unpaired.status}`);
    const paired = await fetchWithTimeout(`${domain}/vnc.html?token=${encodeURIComponent(password)}`, {}, httpTimeoutMs, signal);
    check('authenticated noVNC HTTP', paired.status === 200, `status=${paired.status}`);
  }, { timeoutMs: httpTimeoutMs * 2 });
  const websocketStatus = await timed('websocket', (signal) => probeWebSocket(domain, cookie, { signal, timeoutMs: httpTimeoutMs }), { timeoutMs: httpTimeoutMs });
  check('authenticated noVNC WebSocket', websocketStatus.includes('101'), websocketStatus);

  const terminalRun = await timed('terminal', async (signal) => {
    const terminal = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', 'printf terminal-ready'],
      detached: true,
      signal,
      timeoutMs: commandTimeoutMs,
    });
    const result = await terminal.wait({ signal });
    const output = await bounded(
      'terminal output',
      (outputSignal) => result.stdout({ signal: outputSignal }),
      signal,
      commandTimeoutMs,
    );
    return { commandId: terminal.cmdId, result, output };
  }, { timeoutMs: commandTimeoutMs });
  const terminalOutput = terminalRun.output;
  check('terminal session', terminalRun.result.exitCode === 0 && terminalOutput.includes('terminal-ready'));
  report.terminalSession = {
    commandId: terminalRun.commandId,
    exitCode: terminalRun.result.exitCode,
    state: terminalRun.result.exitCode === 0 ? 'completed' : 'failed',
  };
  await timed('session-terminal', (signal) => listSessions('after-terminal', sandbox, signal));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.failed = true;
} finally {
  clearTimeout(smokeDeadlineTimer);
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(() => {
    cleanupController.abort(new Error(`cleanup deadline exceeded after ${cleanupTimeoutMs}ms`));
  }, cleanupTimeoutMs);
  const cleanupSignal = cleanupController.signal;
  if (sandbox) {
    try {
      await timed('stop', async (signal) => {
        if (!TERMINAL_SESSION_STATES.has(sandbox.status)) await sandbox.stop({ signal });
        const finalStates = await listSessions('after-stop', sandbox, signal);
        report.cleanup.stopped = finalStates.length > 0 && finalStates.every((session) => TERMINAL_SESSION_STATES.has(session.status));
        if (!report.cleanup.stopped) throw new Error('not every final Sandbox session is stopped or aborted');
      }, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs, respectSmokeDeadline: false });
    } catch (error) {
      markCleanupFailure('stopped', error instanceof Error ? error.message : error);
    }

    try {
      await timed('snapshot-cleanup', async (signal) => {
        try {
          const snapshots = await listSnapshots(signal);
          report.snapshots = snapshots.map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
          for (const snapshot of snapshots.filter((item) => item.status !== 'deleted')) {
            try {
              await deleteListedSnapshot({
                snapshot,
                signal,
                timeoutMs: sdkTimeoutMs,
                getSnapshot: (snapshotId, getSignal) => Snapshot.get({ ...credentials, snapshotId, signal: getSignal }),
              });
            } catch (error) {
              recordRecoverableCleanupIssue('snapshot cleanup', error);
            }
          }
          const residual = await listSnapshots(signal);
          report.snapshots = residual.map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
          report.cleanup.residualNonDeletedSnapshots = residual
            .filter((snapshot) => snapshot.status !== 'deleted')
            .map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
          report.cleanup.snapshotsCleaned = report.cleanup.residualNonDeletedSnapshots.length === 0;
          if (!report.cleanup.snapshotsCleaned) recordRecoverableCleanupIssue('snapshot cleanup', 'non-deleted snapshot residual remains');
        } catch (error) {
          recordRecoverableCleanupIssue('snapshot cleanup', error);
        }
      }, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs, respectSmokeDeadline: false });
    } catch (error) {
      markCleanupFailure('snapshotsCleaned', error instanceof Error ? error.message : error);
    }

    try {
      await timed('delete', async (signal) => {
        let initialDeleteError;
        try {
          await boundedCall(
            (requestSignal) => sandbox.delete({ signal: requestSignal }),
            'initial Sandbox delete',
            { signal, timeoutMs: sdkTimeoutMs },
          );
          report.cleanup.deleted = true;
        } catch (error) {
          initialDeleteError = error;
          report.cleanup.recovery ??= [];
          report.cleanup.recovery.push({ operation: 'initial-delete', outcome: 'rejected', detail: String(error).slice(0, 500) });
        }
        // Always verify/recover after the initial delete attempt, including a
        // timeout or API rejection; the verifier itself never resumes.
        const verification = await verifyDeleted(sandbox.name, signal);
        report.cleanup.deletionVerified = verification.verified;
        report.cleanup.noRunningSessionAfterDelete = verification.noRunningSession === true;
        report.cleanup.stopped = report.cleanup.stopped || verification.noRunningSession === true;
        report.cleanup.deleted = report.cleanup.deleted || verification.verified;
        if (!report.cleanup.deletionVerified || !report.cleanup.noRunningSessionAfterDelete) {
          throw new Error(initialDeleteError ? 'initial delete rejected and recovery verification failed' : 'Sandbox deletion or no-running-session verification failed');
        }
        try {
          const residualAfterDelete = await listSnapshots(signal);
          report.snapshots = residualAfterDelete.map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
          report.cleanup.residualNonDeletedSnapshots = residualAfterDelete
            .filter((snapshot) => snapshot.status !== 'deleted')
            .map((snapshot) => ({ id: snapshot.id, status: snapshot.status }));
          report.cleanup.snapshotsCleaned = report.cleanup.residualNonDeletedSnapshots.length === 0;
          if (!report.cleanup.snapshotsCleaned) recordRecoverableCleanupIssue('snapshot cleanup', 'snapshot residual remains after Sandbox deletion');
        } catch (error) {
          recordRecoverableCleanupIssue('snapshot cleanup', error);
        }
      }, { signal: cleanupSignal, timeoutMs: cleanupTimeoutMs, respectSmokeDeadline: false });
    } catch (error) {
      markCleanupFailure('deleted', error instanceof Error ? error.message : error);
      report.cleanup.deletionVerified = false;
      report.cleanup.noRunningSessionAfterDelete = false;
    }
  }

  try {
    const ownedRecovery = await timed('owned-recovery', (signal) => recoverOwned(signal), {
      signal: cleanupSignal,
      timeoutMs: cleanupTimeoutMs,
      respectSmokeDeadline: false,
    });
    applyOwnedRecoveryEvidence(report, ownedRecovery);
    if (ownedRecovery.errors.length === 0 && ownedRecovery.recoveredSandboxes.length > 0) {
      report.cleanup.stopped = true;
      report.cleanup.deleted = true;
      report.cleanup.deletionVerified = true;
      report.cleanup.noRunningSessionAfterDelete = true;
    }
  } catch (error) {
    markCleanupFailure('deleted', error instanceof Error ? error.message : error);
    report.cleanup.deletionVerified = false;
    report.cleanup.noRunningSessionAfterDelete = false;
  }
  clearTimeout(cleanupTimer);
  report.cleanup.finalSessionStatesTerminal = finalSessionStatesAreTerminal();
  report.requiredChecksComplete = REQUIRED_SMOKE_CHECKS.every((name) => report.checks.some((check) => check.name === name && check.ok === true));
  if (!report.cleanup.finalSessionStatesTerminal || !report.requiredChecksComplete || (Array.isArray(report.cleanup.errors) && report.cleanup.errors.length > 0)) report.failed = true;
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAtMs;
  await mkdir(dirname(reportPath), { recursive: true });
  // Password never enters the report; the artifact redaction step adds the
  // final redacted marker before promotion consumes this evidence.
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (
  report.failed ||
  report.checks.some((item) => !item.ok) ||
  !report.cleanup.stopped ||
  !report.cleanup.deleted ||
  !report.cleanup.deletionVerified ||
  !report.cleanup.noRunningSessionAfterDelete ||
  !report.cleanup.discoveryConverged ||
  !report.cleanup.snapshotsCleaned ||
  !report.cleanup.finalSessionStatesTerminal ||
  !report.requiredChecksComplete ||
  report.cleanup.residualNonDeletedSnapshots.length > 0 ||
  (Array.isArray(report.cleanup.errors) && report.cleanup.errors.length > 0)
) {
  process.exitCode = 1;
}
