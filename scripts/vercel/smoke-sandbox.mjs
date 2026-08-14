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
import { parseFullyQualifiedVcrReference } from './smoke-contract.mjs';

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
const password = randomBytes(24).toString('base64url');
const username = 'devbox-smoke';
const terminalStates = new Set(['stopped', 'aborted']);
const report = {
  redacted: false,
  role,
  scope: { teamId, projectId },
  imageReference: image,
  expectedDigest,
  smokeUrl,
  startedAt: new Date(startedAtMs).toISOString(),
  checks: [],
  timings: {},
  sessionStates: [],
  snapshots: [],
  cleanup: {
    stopped: false,
    deleted: false,
    deletionVerified: false,
    snapshotsCleaned: false,
    residualNonDeletedSnapshots: [],
  },
};
let sandbox;

function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail: String(detail).slice(0, 500) });
  if (!ok) throw new Error(`${name} failed`);
}

async function timed(stage, operation) {
  const startedStageAtMs = Date.now();
  const timing = {
    startedAt: new Date(startedStageAtMs).toISOString(),
    startedEpochMs: startedStageAtMs,
  };
  report.timings[stage] = timing;
  try {
    const result = await operation();
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
  const result = await sandbox.runCommand({ cmd, args, ...options });
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  return { exitCode: result.exitCode, stdout, stderr };
}

function probeWebSocket(url, authorization) {
  return new Promise((resolve, reject) => {
    const target = new URL('/websockify', url);
    const secure = target.protocol === 'https:';
    const socket = secure
      ? tls.connect({ host: target.hostname, port: Number(target.port || 443), servername: target.hostname })
      : net.connect(Number(target.port || 80), target.hostname);
    const key = randomBytes(16).toString('base64');
    let response = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(15_000, () => finish(new Error('WebSocket probe timed out')));
    socket.once('error', (error) => finish(error));
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write([
        'GET /websockify HTTP/1.1',
        `Host: ${target.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Authorization: Basic ${authorization}`,
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

async function listSnapshots() {
  const result = await Snapshot.list({ ...credentials, name: sandbox.name, limit: 100 });
  return result.toArray();
}

async function listSessions(phase) {
  const result = await sandbox.listSessions({ limit: 100, sortOrder: 'asc' });
  const sessions = await result.toArray();
  const states = sessions.map((session) => ({
    id: session.id,
    status: session.status,
    observedAt: new Date().toISOString(),
  }));
  report.sessionStates.push({ phase, states });
  return states;
}

function isNotFound(error) {
  return error instanceof APIError && [404, 410].includes(error.response.status);
}

async function verifyDeleted() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const existing = await Sandbox.get({ ...credentials, name: sandbox.name });
      if (attempt === 4) return { verified: false, status: existing.status };
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    } catch (error) {
      if (isNotFound(error)) return { verified: true };
      throw error;
    }
  }
  return { verified: false };
}

function finalSessionStatesAreTerminal() {
  const observations = report.sessionStates.flatMap((observation) => observation.states);
  if (observations.length === 0) return false;
  const finalObservation = report.sessionStates.at(-1)?.states ?? [];
  return finalObservation.length > 0 && finalObservation.every((session) => terminalStates.has(session.status));
}

function markCleanupFailure(name, detail) {
  report.cleanup[name] = false;
  report.cleanup.errors ??= [];
  report.cleanup.errors.push(String(detail).slice(0, 500));
  report.failed = true;
}

try {
  sandbox = await timed('create', () => Sandbox.create({
    ...credentials,
    image,
    ports: [6081],
    persistent: false,
    timeout: 10 * 60 * 1000,
    tags: { 'devbox-image': `smoke-${role}` },
  }));
  report.sandboxName = sandbox.name;
  await timed('session-create', () => listSessions('created'));
  check('image digest', sandbox.image?.endsWith(`@${expectedDigest}`), 'Sandbox resolved the candidate digest');

  const identity = await command('id', ['-u']);
  check('non-root user', identity.exitCode === 0 && identity.stdout.trim() !== '0', identity.stdout.trim());
  const usernameResult = await command('id', ['-un']);
  check('expected non-root identity', usernameResult.exitCode === 0 && usernameResult.stdout.trim() !== 'root', usernameResult.stdout.trim());
  const sudo = await command('sudo', ['-n', 'true']);
  check('passwordless sudo', sudo.exitCode === 0);

  const binaries = ['pi', 'claude', 'codex', 'opencode', 'gh', 'node', 'bun', 'python', 'chromium', 'Xvfb', 'fluxbox', 'x11vnc', 'websockify'];
  for (const binary of binaries) {
    const found = await command('bash', ['-lc', `command -v ${binary}`]);
    check(`binary ${binary}`, found.exitCode === 0, found.stdout.trim());
  }

  const startResult = await timed('startup', async () => {
    const start = await sandbox.runCommand({
      cmd: '/usr/local/bin/devbox-start',
      env: { DEVBOX_NOVNC_USER: username, DEVBOX_NOVNC_PASSWORD: password },
      detached: true,
    });
    return start.wait();
  });
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
  const authorization = Buffer.from(`${username}:${password}`).toString('base64');
  await timed('http', async () => {
    const unauthorized = await fetch(`${domain}/vnc.html`);
    check('noVNC rejects unauthenticated HTTP', unauthorized.status === 401, `status=${unauthorized.status}`);
    const authorized = await fetch(`${domain}/vnc.html`, { headers: { Authorization: `Basic ${authorization}` } });
    check('authenticated noVNC HTTP', authorized.status === 200, `status=${authorized.status}`);
  });
  const websocketStatus = await timed('websocket', () => probeWebSocket(domain, authorization));
  check('authenticated noVNC WebSocket', websocketStatus.includes('101'), websocketStatus);

  const terminalRun = await timed('terminal', async () => {
    const terminal = await sandbox.runCommand({ cmd: 'bash', args: ['-lc', 'printf terminal-ready'], detached: true });
    return { commandId: terminal.cmdId, result: await terminal.wait() };
  });
  const terminalOutput = await terminalRun.result.stdout();
  check('terminal session', terminalRun.result.exitCode === 0 && terminalOutput.includes('terminal-ready'));
  report.terminalSession = {
    commandId: terminalRun.commandId,
    exitCode: terminalRun.result.exitCode,
    state: terminalRun.result.exitCode === 0 ? 'completed' : 'failed',
  };
  await timed('session-terminal', () => listSessions('after-terminal'));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.failed = true;
} finally {
  if (sandbox) {
    try {
      await timed('stop', async () => {
        if (!terminalStates.has(sandbox.status)) await sandbox.stop();
        const finalStates = await listSessions('after-stop');
        report.cleanup.stopped = finalStates.length > 0 && finalStates.every((session) => terminalStates.has(session.status));
        if (!report.cleanup.stopped) throw new Error('not every final Sandbox session is stopped or aborted');
      });
    } catch (error) {
      markCleanupFailure('stopped', error instanceof Error ? error.message : error);
    }

    try {
      await timed('snapshot-cleanup', async () => {
        const snapshots = await listSnapshots();
        report.snapshots = snapshots.map((snapshot) => ({ id: snapshot.snapshotId, status: snapshot.status }));
        for (const snapshot of snapshots.filter((item) => item.status !== 'deleted')) {
          await snapshot.delete();
        }
        const residual = await listSnapshots();
        report.snapshots = residual.map((snapshot) => ({ id: snapshot.snapshotId, status: snapshot.status }));
        report.cleanup.residualNonDeletedSnapshots = residual
          .filter((snapshot) => snapshot.status !== 'deleted')
          .map((snapshot) => ({ id: snapshot.snapshotId, status: snapshot.status }));
        report.cleanup.snapshotsCleaned = report.cleanup.residualNonDeletedSnapshots.length === 0;
        if (!report.cleanup.snapshotsCleaned) throw new Error('non-deleted snapshot residual remains');
      });
    } catch (error) {
      markCleanupFailure('snapshotsCleaned', error instanceof Error ? error.message : error);
    }

    try {
      await timed('delete', async () => {
        await sandbox.delete();
        report.cleanup.deleted = true;
        const verification = await verifyDeleted();
        report.cleanup.deletionVerified = verification.verified;
        if (!report.cleanup.deletionVerified) throw new Error('Sandbox deletion could not be verified');
        const residualAfterDelete = await listSnapshots();
        report.snapshots = residualAfterDelete.map((snapshot) => ({ id: snapshot.snapshotId, status: snapshot.status }));
        report.cleanup.residualNonDeletedSnapshots = residualAfterDelete
          .filter((snapshot) => snapshot.status !== 'deleted')
          .map((snapshot) => ({ id: snapshot.snapshotId, status: snapshot.status }));
        report.cleanup.snapshotsCleaned = report.cleanup.residualNonDeletedSnapshots.length === 0;
        if (!report.cleanup.snapshotsCleaned) throw new Error('snapshot residual remains after Sandbox deletion');
      });
    } catch (error) {
      markCleanupFailure('deleted', error instanceof Error ? error.message : error);
      report.cleanup.deletionVerified = false;
    }
  }
  report.cleanup.finalSessionStatesTerminal = finalSessionStatesAreTerminal();
  if (!report.cleanup.finalSessionStatesTerminal) report.failed = true;
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
  !report.cleanup.snapshotsCleaned ||
  !report.cleanup.finalSessionStatesTerminal ||
  report.cleanup.residualNonDeletedSnapshots.length > 0
) {
  process.exitCode = 1;
}
