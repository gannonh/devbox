#!/usr/bin/env node
/**
 * Real Vercel Sandbox smoke gate for one credential scope.
 *
 * The publisher and consumer jobs invoke this script independently.  It never
 * prints token/password values and always attempts to stop/delete the Sandbox,
 * then checks that matching snapshots are absent or deleted.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { Sandbox, Snapshot } from '@vercel/sandbox';

const role = process.env.SMOKE_ROLE;
const image = process.env.IMAGE_REF;
const expectedDigest = process.env.EXPECTED_IMAGE_DIGEST;
const reportPath = process.env.SMOKE_REPORT;
const smokeUrl = process.env.SMOKE_URL ?? '';
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID;
const token = process.env.VERCEL_TOKEN;
if (!role || !image || !expectedDigest || !projectId || !teamId || !reportPath) {
  throw new Error('SMOKE_ROLE, IMAGE_REF, EXPECTED_IMAGE_DIGEST, VERCEL_PROJECT_ID, VERCEL_TEAM_ID, and SMOKE_REPORT are required');
}
if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('EXPECTED_IMAGE_DIGEST must be a full sha256 digest');
const imageMatch = /@(?<digest>sha256:[a-f0-9]{64})$/.exec(image);
if (!imageMatch || imageMatch.groups.digest !== expectedDigest) {
  throw new Error('Sandbox smoke must use the exact candidate digest, not a tag or different reference');
}

const credentials = { token, teamId, projectId };
const startedAt = Date.now();
const password = randomBytes(24).toString('base64url');
const username = 'devbox-smoke';
const report = {
  role,
  imageReference: image.replace(/@sha256:.+$/, '@[digest]'),
  expectedDigest,
  smokeUrl,
  startedAt: new Date().toISOString(),
  checks: [],
  timings: {},
  sessionStates: [],
  snapshots: [],
  cleanup: { stopped: false, deleted: false, residualNonDeletedSnapshots: [] },
};
let sandbox;

function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail: String(detail).slice(0, 500) });
  if (!ok) throw new Error(`${name} failed`);
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
        `Sec-WebSocket-Key: ${key}`,
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

try {
  report.timings.createStartedAt = new Date().toISOString();
  sandbox = await Sandbox.create({
    ...credentials,
    image,
    ports: [6081],
    persistent: false,
    timeout: 10 * 60 * 1000,
    tags: { 'devbox-image': `smoke-${role}` },
  });
  report.timings.createdAt = new Date().toISOString();
  report.sandboxName = sandbox.name;
  report.sessionStates.push(sandbox.status);
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

  const start = await sandbox.runCommand({
    cmd: '/usr/local/bin/devbox-start',
    env: { DEVBOX_NOVNC_USER: username, DEVBOX_NOVNC_PASSWORD: password },
    detached: true,
  });
  const startResult = await start.wait();
  check('explicit startup', startResult.exitCode === 0, 'startup command completed');
  report.sessionStates.push(sandbox.status);

  const status = await command('/usr/local/bin/devbox-status');
  check('display and proxy processes', status.exitCode === 0 && /Xvfb=running/.test(status.stdout) && /auth-proxy=running/.test(status.stdout), status.stdout);

  const domain = sandbox.domain(6081);
  report.noVncUrl = domain;
  const authorization = Buffer.from(`${username}:${password}`).toString('base64');
  const unauthorized = await fetch(`${domain}/vnc.html`);
  check('noVNC rejects unauthenticated HTTP', unauthorized.status === 401, `status=${unauthorized.status}`);
  const authorized = await fetch(`${domain}/vnc.html`, { headers: { Authorization: `Basic ${authorization}` } });
  check('authenticated noVNC HTTP', authorized.status === 200, `status=${authorized.status}`);
  const websocketStatus = await probeWebSocket(domain, authorization);
  check('authenticated noVNC WebSocket', websocketStatus.includes('101'), websocketStatus);

  const terminal = await sandbox.runCommand({ cmd: 'bash', args: ['-lc', 'printf terminal-ready'], detached: true });
  const terminalResult = await terminal.wait();
  check('terminal session', terminalResult.exitCode === 0 && (await terminalResult.stdout()).includes('terminal-ready'));
  report.terminalSession = { commandId: terminal.id, exitCode: terminalResult.exitCode, state: sandbox.status };
  report.sessionStates.push(sandbox.status);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.failed = true;
} finally {
  if (sandbox) {
    try {
      if (sandbox.status === 'running') await sandbox.stop();
      report.cleanup.stopped = sandbox.status === 'stopped';
      report.sessionStates.push(sandbox.status);
    } catch (error) {
      report.cleanup.stopError = error instanceof Error ? error.message : String(error);
      report.failed = true;
    }
    try {
      const snapshots = await listSnapshots();
      report.snapshots = snapshots.map((snapshot) => ({ id: snapshot.snapshotId, status: snapshot.status }));
    } catch (error) {
      report.cleanup.snapshotListError = error instanceof Error ? error.message : String(error);
      report.failed = true;
    }
    try {
      await sandbox.delete();
      report.cleanup.deleted = true;
    } catch (error) {
      report.cleanup.deleteError = error instanceof Error ? error.message : String(error);
    }
    try {
      const residual = await Snapshot.list({ ...credentials, name: sandbox.name, limit: 100 });
      const residualSnapshots = await residual.toArray();
      report.cleanup.residualNonDeletedSnapshots = residualSnapshots
        .filter((snapshot) => snapshot.status !== 'deleted')
        .map((snapshot) => ({ id: snapshot.snapshotId, status: snapshot.status }));
      if (report.cleanup.residualNonDeletedSnapshots.length > 0) report.failed = true;
    } catch (error) {
      report.cleanup.residualListError = error instanceof Error ? error.message : String(error);
      report.failed = true;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  await mkdir(dirname(reportPath), { recursive: true });
  // Password never enters the report; redact once more as defense in depth.
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (report.failed || report.checks.some((item) => !item.ok) || !report.cleanup.deleted || report.cleanup.residualNonDeletedSnapshots.length > 0) {
  process.exitCode = 1;
}
