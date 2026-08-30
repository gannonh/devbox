#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { createVercelIdentity } from '../../dist/providers/vercel/identity.js';

const execFile = promisify(execFileCallback);

const APP_PORT = 4173;
const DURATION_TIMEOUT_MINUTES = 60;
const DURATION_IDLE_BOUNDARY_MS = positiveInteger('DEVBOX_UAT_IDLE_BOUNDARY_MS', 15 * 60 * 1000);
const DURATION_FINAL_WINDOW_MS = positiveInteger('DEVBOX_UAT_FINAL_WINDOW_MS', 60 * 1000);
const DURATION_STOP_TIMEOUT_MS = positiveInteger('DEVBOX_UAT_STOP_TIMEOUT_MS', 180 * 1000);
const DURATION_PROVIDER_POLL_MS = positiveInteger('DEVBOX_UAT_PROVIDER_POLL_MS', 2 * 1000);
const MODE = process.argv[2] === '--cleanup'
  ? 'cleanup'
  : process.env.DEVBOX_UAT_MODE ?? 'reconnect';
const REPO_ROOT = required('DEVBOX_UAT_REPO_ROOT');
const BRANCH = required('DEVBOX_UAT_BRANCH');
const CLI_PATH = resolve(process.env.DEVBOX_CLI ?? 'dist/cli.js');
const REPORT_PATH = process.env.DEVBOX_UAT_REPORT ?? resolve('uat-evidence/session-uat.json');
const STATE_HOME = process.env.DEVBOX_UAT_STATE_HOME;
const TIMEOUT_MINUTES = positiveInteger('DEVBOX_UAT_TIMEOUT_MINUTES', 60);
const CLI_TIMEOUT_MS = positiveInteger('DEVBOX_UAT_CLI_TIMEOUT_MS', 120_000);
const MARKER_TIMEOUT_MS = positiveInteger('DEVBOX_UAT_MARKER_TIMEOUT_MS', 45_000);
const secrets = Object.entries(process.env)
  .filter(([name, value]) => /TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL/i.test(name) && value)
  .map(([, value]) => value);

const report = {
  schemaVersion: 1,
  redacted: true,
  mode: MODE,
  branchFingerprint: fingerprint(BRANCH),
  timeoutMinutes: TIMEOUT_MINUTES,
  checks: [],
  preflight: { attempted: false, exitCode: null, accepted: false },
  cleanup: { attempted: false, exitCode: null, accepted: false },
};

let ownedStateHome = false;
let activeStateHome;

main().then(async (code) => {
  report.finishedAt = new Date().toISOString();
  report.failed = code !== 0;
  await writeReport();
  if (ownedStateHome) await rm(activeStateHome, { recursive: true, force: true });
  process.exit(code);
}, async (error) => {
  report.finishedAt = new Date().toISOString();
  report.failed = true;
  report.error = redact(error instanceof Error ? error.message : String(error));
  await writeReport();
  if (ownedStateHome) await rm(activeStateHome, { recursive: true, force: true });
  process.stderr.write(`${report.error}\n`);
  process.exit(1);
});

async function main() {
  const stateHome = await stateDirectory();
  if (MODE === 'cleanup') {
    const result = await runCleanup(stateHome);
    report.cleanup = result;
    return result.accepted ? 0 : 1;
  }
  if (MODE === 'duration' && TIMEOUT_MINUTES !== DURATION_TIMEOUT_MINUTES) {
    throw new Error(`duration UAT requires a ${DURATION_TIMEOUT_MINUTES}-minute Sandbox lease`);
  }

  const preflight = await runCleanup(stateHome);
  report.preflight = { attempted: true, ...preflight };
  if (!preflight.accepted) throw new Error(`preflight cleanup failed with exit code ${preflight.exitCode}`);

  let active;
  try {
    active = await startSession(stateHome);
    await verifyInitialSession(active);
    if (MODE === 'duration') {
      await verifyDurationSession(stateHome, active);
    } else {
      await verifyReconnectSession(stateHome, active);
    }
  } finally {
    if (active) await active.close('SIGTERM');
    const cleanup = await runCleanup(stateHome);
    report.cleanup = { attempted: true, ...cleanup };
    if (!cleanup.accepted) report.failed = true;
  }
  return report.checks.every((check) => check.ok) && report.cleanup.accepted ? 0 : 1;
}

async function stateDirectory() {
  if (STATE_HOME) {
    await mkdir(STATE_HOME, { recursive: true });
    activeStateHome = STATE_HOME;
    return STATE_HOME;
  }
  const stateHome = await mkdtemp('/tmp/devbox-session-uat-state-');
  ownedStateHome = true;
  activeStateHome = stateHome;
  return stateHome;
}

async function startSession(stateHome) {
  const args = [
    CLI_PATH,
    BRANCH,
    '--provider',
    'vercel',
    ...(MODE === 'duration' ? ['--timeout', String(TIMEOUT_MINUTES)] : []),
    '--expose-ports',
    '4173',
  ];
  const session = createPty(args, stateHome);
  const first = await session.waitForAny([
    'Create this Vercel sandbox?',
    `session duration: ${TIMEOUT_MINUTES} minutes`,
    '▲ ',
  ], CLI_TIMEOUT_MS);
  if (first.match === 'Create this Vercel sandbox?') session.write('y\n');
  await session.waitFor(`session duration: ${TIMEOUT_MINUTES} minutes`, CLI_TIMEOUT_MS);
  await session.waitFor('▲ ', CLI_TIMEOUT_MS);
  return {
    ...session,
    publicUrl: publicRoute(session.output(), APP_PORT),
    provider: await readProviderSessionFacts(stateHome),
  };
}

async function verifyInitialSession(session) {
  const marker = markerFor('identity');
  session.write(remoteIdentityCommand(marker));
  const output = await session.waitFor(marker, MARKER_TIMEOUT_MS);
  const identity = parseIdentity(output, marker);
  check('initial named tmux session', identity.session === 'devbox', `session=${identity.session}`);
  check('initial session socket', identity.socket.startsWith('/tmp/devbox-tmux/session-'), 'socket uses the devbox-owned session directory');
  report.initial = { pid: identity.pid, tmuxSession: identity.session, socket: identity.socket };
  return identity;
}

async function verifyDurationSession(stateHome, session) {
  const provider = session.provider;
  check('dedicated session duration', report.timeoutMinutes === DURATION_TIMEOUT_MINUTES, `timeout=${report.timeoutMinutes} minutes`);
  check('provider configured timeout', provider.configuredTimeoutMs === DURATION_TIMEOUT_MINUTES * 60 * 1000, `timeout=${provider.configuredTimeoutMs}ms`);
  check('provider session identity recorded', Boolean(provider.sandboxName && provider.sessionId), 'provider Sandbox name and session ID are present');
  check('provider creation time recorded', Number.isFinite(Date.parse(provider.createdAt)), `createdAt=${provider.createdAt}`);
  const expiresAtMs = Date.parse(provider.expiresAt ?? '');
  check('provider deadline recorded', Number.isFinite(expiresAtMs), `expiresAt=${provider.expiresAt}`);

  const reconnect = await verifySameSessionReconnect(stateHome, session, 'duration-http-fixture');
  const snapshotProcess = await startSnapshotProcess(stateHome);
  const quietStartedAt = Date.now();
  const idleBoundaryAt = await waitForDeadline(quietStartedAt + DURATION_IDLE_BOUNDARY_MS);
  const idleProvider = await readProviderSessionFacts(undefined, provider.sandboxName);
  check('duration idle provider session', idleProvider.status === 'running' && idleProvider.sessionId === provider.sessionId, `status=${idleProvider.status}; sessionId=${idleProvider.sessionId}`);
  const idleResponse = await waitForFixture(reconnect.publicUrl, reconnect.fixtureMarker);
  check('duration survives idle boundary', idleResponse.pid === reconnect.startedIdentity.pid, `initial=${reconnect.startedIdentity.pid}; idle=${idleResponse.pid}`);
  check('duration idle tmux session', idleResponse.session === reconnect.startedIdentity.session, `initial=${reconnect.startedIdentity.session}; idle=${idleResponse.session}`);
  check('duration idle HTTP marker', idleResponse.marker === reconnect.fixtureMarker, 'fixture remained reachable without terminal input');
  check('duration idle HTTP payload', idleResponse.response === 'devbox-uat-http', 'fixture returned the expected payload after the idle boundary');

  const finalProbeTarget = expiresAtMs - DURATION_FINAL_WINDOW_MS;
  check('duration final window is reachable', finalProbeTarget > Date.now(), 'final probe target is after the idle boundary');
  await waitForDeadline(finalProbeTarget);
  const finalProbeAt = new Date().toISOString();
  const finalProvider = await readProviderSessionFacts(undefined, provider.sandboxName);
  check('duration final provider session', finalProvider.status === 'running' && finalProvider.sessionId === provider.sessionId, `status=${finalProvider.status}; sessionId=${finalProvider.sessionId}`);
  const finalResponse = await waitForFixture(reconnect.publicUrl, reconnect.fixtureMarker);
  const remainingMs = expiresAtMs - Date.now();
  check('duration final HTTP response', finalResponse.pid === reconnect.startedIdentity.pid, `initial=${reconnect.startedIdentity.pid}; final=${finalResponse.pid}`);
  check('duration final HTTP marker', finalResponse.marker === reconnect.fixtureMarker, 'fixture remained reachable in the final lease window');
  check('duration final HTTP payload', finalResponse.response === 'devbox-uat-http', 'fixture returned the expected payload in the final lease window');
  check('duration final lease window', remainingMs >= 0 && remainingMs <= DURATION_FINAL_WINDOW_MS, `remaining=${remainingMs}ms`);

  await stopFixture(reconnect.publicUrl, reconnect.fixtureMarker);
  const stopped = await waitForProviderStop(provider.sandboxName, DURATION_STOP_TIMEOUT_MS);
  const retainedSnapshots = await waitForRetainedSnapshots(provider.sandboxName, DURATION_STOP_TIMEOUT_MS);
  const resumed = await resumeSnapshot(stateHome, snapshotProcess, {
    socket: report.initial.socket,
    providerSessionId: provider.sessionId,
  });
  check('duration provider stop observed', ['stopped', 'aborted'].includes(stopped.status), `status=${stopped.status}`);
  check('duration one retained snapshot', retainedSnapshots.length === 1, `createdSnapshots=${retainedSnapshots.length}`);
  report.duration = {
    configuredTimeoutMs: provider.configuredTimeoutMs,
    sessionId: provider.sessionId,
    sandboxName: provider.sandboxName,
    createdAt: provider.createdAt,
    expiresAt: provider.expiresAt,
    idleStatus: idleProvider.status,
    idleSessionId: idleProvider.sessionId,
    finalStatus: finalProvider.status,
    finalSessionId: finalProvider.sessionId,
    idleBoundaryAt: new Date(idleBoundaryAt).toISOString(),
    quietStartedAt: new Date(quietStartedAt).toISOString(),
    finalProbeAt,
    finalRemainingMs: remainingMs,
    stoppedAt: stopped.observedAt,
    stoppedStatus: stopped.status,
    retainedSnapshots: retainedSnapshots.map((snapshot) => ({ id: snapshot.id, status: snapshot.status })),
    resumedSessionId: resumed.identity.sessionId,
    resumedSandboxName: resumed.identity.sandboxName,
  };
}

async function readProviderSessionFacts(stateHome, sandboxName = undefined) {
  const name = sandboxName ?? await readStoredSandboxName(stateHome);
  const sandbox = await Sandbox.get({ ...providerCredentials(), name, resume: false });
  const current = sandbox.currentSession();
  if (!current?.sessionId) throw new Error('Vercel provider session facts did not include a session ID');
  return {
    sandboxName: sandbox.name,
    sessionId: current.sessionId,
    status: current.status,
    configuredTimeoutMs: current.timeout,
    createdAt: current.createdAt.toISOString(),
    expiresAt: sandbox.expiresAt?.toISOString() ?? null,
    currentSnapshotId: sandbox.currentSnapshotId ?? null,
  };
}

async function readStoredSandboxName(stateHome) {
  const directory = resolve(stateHome, 'devbox', 'providers', 'vercel');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Vercel UAT metadata directory is unreadable: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = resolve(directory, entry.name);
    let metadataText;
    try {
      metadataText = await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`Vercel UAT metadata file is unreadable: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
    let metadata;
    try {
      metadata = JSON.parse(metadataText);
    } catch (error) {
      throw new Error(`Vercel UAT metadata file is malformed: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
    const identity = metadata?.identity;
    if (identity?.branch === BRANCH && typeof identity.name === 'string' && identity.name) return identity.name;
  }
  throw new Error('Vercel UAT metadata did not contain the branch Sandbox name');
}

async function listProviderSnapshots(sandboxName) {
  const page = await Snapshot.list({ ...providerCredentials(), name: sandboxName, limit: 50 });
  return page.toArray();
}

async function waitForRetainedSnapshots(sandboxName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshots = [];
  let lastError;
  while (Date.now() < deadline) {
    try {
      snapshots = await listProviderSnapshots(sandboxName);
      const retained = snapshots.filter((snapshot) => snapshot.status === 'created');
      if (retained.length === 1) return retained;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(DURATION_PROVIDER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  if (lastError) throw lastError;
  throw new Error(`Vercel provider did not retain exactly one created snapshot; found ${snapshots.filter((snapshot) => snapshot.status === 'created').length}`);
}

async function waitForProviderStop(sandboxName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const facts = await readProviderSessionFacts(undefined, sandboxName);
      if (['stopped', 'aborted'].includes(facts.status)) return { ...facts, observedAt: new Date().toISOString() };
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(DURATION_PROVIDER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw lastError ?? new Error('Vercel provider Sandbox did not stop before the UAT deadline');
}

async function waitForDeadline(deadline) {
  while (Date.now() < deadline) {
    await delay(Math.min(30_000, Math.max(1, deadline - Date.now())));
  }
  return Date.now();
}

function providerCredentials() {
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!token || !teamId || !projectId) {
    throw new Error('VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are required for provider probes');
  }
  return { token, teamId, projectId };
}

async function verifyReconnectSession(stateHome, initial) {
  const reconnect = await verifySameSessionReconnect(stateHome, initial, 'http-fixture');
  await stopFixture(reconnect.publicUrl, reconnect.fixtureMarker);
  await verifySnapshotBoundary(stateHome, {
    socket: report.initial.socket,
    providerSessionId: initial.provider.sessionId,
  });
}

async function verifySameSessionReconnect(stateHome, initial, label) {
  const fixtureMarker = markerFor(label);
  initial.write(remoteHttpFixtureCommand(fixtureMarker));
  const startedOutput = await initial.waitFor(fixtureMarker, MARKER_TIMEOUT_MS);
  const startedIdentity = parseFixtureStartup(startedOutput, fixtureMarker);
  check('foreground HTTP fixture', startedIdentity.session === 'devbox', `session=${startedIdentity.session}`);
  const initialResponse = await waitForFixture(initial.publicUrl, fixtureMarker);
  check('initial HTTP response', initialResponse.pid === startedIdentity.pid, `pid=${initialResponse.pid}`);
  check('initial HTTP marker', initialResponse.marker === fixtureMarker, 'unique fixture marker returned');
  check('initial HTTP payload', initialResponse.response === 'devbox-uat-http', 'fixture returned the expected payload');
  await initial.close('SIGKILL');

  const forcedAttach = await attachSession(stateHome);
  try {
    const forcedResponse = await waitForFixture(initial.publicUrl, fixtureMarker);
    check('forced-close same foreground PID', forcedResponse.pid === startedIdentity.pid, `initial=${startedIdentity.pid}; reconnect=${forcedResponse.pid}`);
    check('forced-close same tmux session', forcedResponse.session === startedIdentity.session, `initial=${startedIdentity.session}; reconnect=${forcedResponse.session}`);
    check('forced-close same HTTP marker', forcedResponse.marker === fixtureMarker, 'fixture survived transport loss');
    check('forced-close same HTTP response', forcedResponse.response === 'devbox-uat-http', 'same fixture response returned after reconnect');
  } finally {
    await forcedAttach.close('SIGTERM');
  }

  const cleanAttach = await attachSession(stateHome);
  try {
    const cleanResponse = await waitForFixture(initial.publicUrl, fixtureMarker);
    check('clean attach same foreground PID', cleanResponse.pid === startedIdentity.pid, `initial=${startedIdentity.pid}; attach=${cleanResponse.pid}`);
    check('clean attach same tmux session', cleanResponse.session === startedIdentity.session, `initial=${startedIdentity.session}; attach=${cleanResponse.session}`);
    check('clean attach same HTTP marker', cleanResponse.marker === fixtureMarker, 'fixture survived clean detach');
    check('clean attach same HTTP response', cleanResponse.response === 'devbox-uat-http', 'same fixture response returned after clean attach');
    cleanAttach.write(Buffer.from([0x1d]));
    await cleanAttach.waitForExit(CLI_TIMEOUT_MS);
  } finally {
    await cleanAttach.close('SIGTERM');
  }
  check('clean Ctrl-] detach', true, 'explicit --attach returned without stopping the VM session');
  report.reconnect = {
    fixtureMarker,
    initialPid: startedIdentity.pid,
    forcedClosePid: startedIdentity.pid,
    cleanAttachPid: startedIdentity.pid,
    tmuxSession: startedIdentity.session,
  };
  return {
    fixtureMarker,
    publicUrl: initial.publicUrl,
    startedIdentity,
  };
}

async function attachSession(stateHome) {
  const session = createPty([CLI_PATH, BRANCH, '--provider', 'vercel', '--attach'], stateHome);
  await session.waitFor('▲ ', CLI_TIMEOUT_MS);
  return session;
}

async function readIdentity(session, label) {
  const marker = markerFor(label);
  session.write(remoteIdentityCommand(marker));
  return parseIdentity(await session.waitFor(marker, MARKER_TIMEOUT_MS), marker);
}

async function runCleanup(stateHome) {
  const session = createPty([CLI_PATH, BRANCH, '--provider', 'vercel', '--rm'], stateHome);
  const exitCode = await session.waitForExit(CLI_TIMEOUT_MS);
  const output = session.output();
  const commandAccepted = exitCode === 0 || /No Vercel sandbox|No matching Vercel sandbox|nothing to remove/i.test(output);
  let inventory;
  let inventoryError;
  try {
    inventory = await waitForEmptyResourceInventory(DURATION_STOP_TIMEOUT_MS);
  } catch (error) {
    inventoryError = redact(error instanceof Error ? error.message : String(error));
  }
  const accepted = commandAccepted && inventory?.sandboxCount === 0 && inventory.snapshotCount === 0;
  return {
    attempted: true,
    exitCode,
    accepted,
    commandAccepted,
    ...(inventory === undefined ? {} : { inventory }),
    ...(inventoryError === undefined ? {} : { inventoryError }),
  };
}

async function waitForEmptyResourceInventory(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastInventory = { sandboxCount: -1, snapshotCount: -1 };
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastInventory = await readResourceInventory();
      if (lastInventory.sandboxCount === 0 && lastInventory.snapshotCount === 0) return lastInventory;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(DURATION_PROVIDER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  if (lastError) throw lastError;
  throw new Error(`Vercel cleanup inventory did not converge: sandboxes=${lastInventory.sandboxCount}; snapshots=${lastInventory.snapshotCount}`);
}

async function readResourceInventory() {
  const identity = await cleanupIdentity();
  const credentials = providerCredentials();
  const sandboxPage = await Sandbox.list({
    ...credentials,
    namePrefix: identity.name,
    tags: identity.tags,
    limit: 50,
  });
  const sandboxes = (await sandboxPage.toArray()).filter((sandbox) => sandbox.name === identity.name);
  const snapshotPage = await Snapshot.list({ ...credentials, name: identity.name, limit: 50 });
  const snapshots = (await snapshotPage.toArray()).filter((snapshot) => snapshot.status !== 'deleted');
  return { sandboxCount: sandboxes.length, snapshotCount: snapshots.length };
}

async function cleanupIdentity() {
  const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
  const credentials = providerCredentials();
  return createVercelIdentity({
    remote: stdout.trim(),
    branch: BRANCH,
    scope: { teamId: credentials.teamId, projectId: credentials.projectId },
  });
}

async function runAction(stateHome, args) {
  const session = createPty([CLI_PATH, ...args], stateHome);
  const exitCode = await session.waitForExit(CLI_TIMEOUT_MS);
  return { exitCode, output: session.output() };
}

async function startSnapshotProcess(stateHome) {
  const session = await attachSession(stateHome);
  const startedMarker = markerFor('snapshot-process-started');
  const processMarker = markerFor('snapshot-process');
  const sentinelPath = `/vercel/sandbox/.devbox-uat-sentinel-${randomBytes(8).toString('hex')}`;
  session.write(remoteDetachedProcessCommand(startedMarker, processMarker, sentinelPath));
  const output = await session.waitFor(startedMarker, MARKER_TIMEOUT_MS);
  const priorProcess = parseDetachedProcessStartup(output, startedMarker);
  check('snapshot process marker recorded', priorProcess.marker === processMarker, 'the detached process carried a unique marker');
  session.write(Buffer.from([0x1d]));
  await session.waitForExit(CLI_TIMEOUT_MS);
  return { ...priorProcess, sentinelPath };
}

async function verifySnapshotBoundary(stateHome, priorIdentity) {
  const priorProcess = await startSnapshotProcess(stateHome);
  const paused = await runAction(stateHome, [BRANCH, '--provider', 'vercel', '--pause']);
  check('snapshot pause', paused.exitCode === 0, 'the public CLI retained a snapshot');
  await resumeSnapshot(stateHome, priorProcess, priorIdentity);
}

async function resumeSnapshot(stateHome, priorProcess, priorIdentity) {
  const resumed = await attachSession(stateHome);
  try {
    await resumed.waitFor('prior user processes ended', CLI_TIMEOUT_MS);
    await resumed.waitFor(`session duration: ${TIMEOUT_MINUTES} minutes`, CLI_TIMEOUT_MS);
    await resumed.waitFor('▲ ', CLI_TIMEOUT_MS);
    publicRoute(resumed.output(), APP_PORT);
    check('snapshot display route returned', hasPublicRoute(resumed.output(), 6080), 'the new VM session published the display route');
    check('snapshot public route returned', hasPublicRoute(resumed.output(), APP_PORT), 'the new VM session published the requested app route');
    const freshIdentity = await readIdentity(resumed, 'snapshot-attach');
    check('snapshot fresh socket', freshIdentity.socket !== priorIdentity.socket, 'snapshot resume received a new session-derived socket');
    check('snapshot fresh tmux session', freshIdentity.session === 'devbox', `session=${freshIdentity.session}`);
    const sentinelPresent = markerFor('snapshot-sentinel-present');
    const sentinelMissing = markerFor('snapshot-sentinel-missing');
    const processPresent = markerFor('snapshot-process-present');
    const processAbsent = markerFor('snapshot-process-absent');
    resumed.write(remoteSnapshotStateCommand(
      sentinelPresent,
      sentinelMissing,
      processPresent,
      processAbsent,
      priorProcess.sentinelPath,
      priorProcess.marker,
      priorProcess.pid,
    ));
    const sentinelState = await resumed.waitForAny([sentinelPresent, sentinelMissing], MARKER_TIMEOUT_MS);
    check('snapshot sentinel restored', sentinelState.match === sentinelPresent, `sentinel=${sentinelState.match}`);
    const processState = await resumed.waitForAny([processPresent, processAbsent], MARKER_TIMEOUT_MS);
    check('snapshot prior process ended', processState.match === processAbsent, `priorPid=${priorProcess.pid}`);
    resumed.write(Buffer.from([0x1d]));
    await resumed.waitForExit(CLI_TIMEOUT_MS);
    const provider = await readProviderSessionFacts(stateHome);
    check('snapshot fresh provider session', provider.sessionId !== priorIdentity.providerSessionId, `prior=${priorIdentity.providerSessionId}; resumed=${provider.sessionId}`);
    check('snapshot resumed timeout', provider.configuredTimeoutMs === TIMEOUT_MINUTES * 60 * 1000, `timeout=${provider.configuredTimeoutMs}ms`);
    report.snapshot = {
      notice: true,
      socketChanged: true,
      priorProcessPid: priorProcess.pid,
      priorProcessEnded: true,
      sentinelRestored: true,
      runtimeServicesRefreshed: true,
      sandboxName: provider.sandboxName,
      sessionId: provider.sessionId,
    };
    return { identity: provider };
  } finally {
    await resumed.close('SIGTERM');
  }
}

function createPty(args, stateHome) {
  const command = [process.execPath, ...args].map(shellQuote).join(' ');
  const child = spawn('script', ['-qefc', command, '/dev/null'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      XDG_STATE_HOME: stateHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return {
    write(value) {
      if (!child.stdin.destroyed) child.stdin.write(value);
    },
    output: () => output,
    waitFor(pattern, timeoutMs) {
      return waitForOutput(child, () => matches(output, pattern), timeoutMs);
    },
    waitForAny(patterns, timeoutMs) {
      return waitForOutput(child, () => patterns.map((pattern) => ({ pattern, match: matches(output, pattern) }))
        .find((entry) => entry.match), timeoutMs);
    },
    waitForExit: (timeoutMs) => waitForExit(child, timeoutMs),
    close: async (signal) => {
      if (child.exitCode !== null) return child.exitCode;
      child.kill(signal);
      return waitForExit(child, 5_000).catch(() => {
        child.kill('SIGKILL');
        return waitForExit(child, 5_000);
      });
    },
  };
}

function waitForOutput(child, probe, timeoutMs) {
  const found = probe();
  if (found) return Promise.resolve(found);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => finish(new Error('CLI PTY marker timeout')), timeoutMs);
    const onData = () => {
      const result = probe();
      if (result) finish(result);
    };
    const onExit = () => finish(new Error('CLI PTY exited before the marker appeared'));
    const finish = (value) => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onData);
      child.removeListener('exit', onExit);
      if (value instanceof Error) reject(value);
      else resolvePromise(value);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => finish(new Error('CLI PTY exit timeout')), timeoutMs);
    const onExit = (code, signal) => finish(undefined, code ?? signalCode(signal));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolvePromise(value);
    };
    child.once('exit', onExit);
  });
}

function remoteIdentityCommand(marker) {
  const encoded = Buffer.from(marker).toString('base64');
  return `printf '%s PID=%s TMUX=%s SOCKET=%s\\n' "$(printf '%s' '${encoded}' | base64 -d)" "$$" "$(tmux display-message -p '#S')" "$(find /tmp/devbox-tmux -mindepth 2 -maxdepth 2 -type s -name socket -print | head -n 1)"\n`;
}

function remoteHttpFixtureCommand(marker) {
  const code = [
    'import http.server, os, subprocess, threading',
    `MARKER = ${JSON.stringify(marker)}`,
    "SESSION = subprocess.check_output(['tmux', 'display-message', '-p', '#S'], text=True).strip()",
    'class Handler(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    "        path = self.path.split('?', 1)[0]",
    "        if path == '/shutdown':",
    "            body = 'fixture-stopping\\n'",
    '            threading.Thread(target=server.shutdown, daemon=True).start()',
    '        else:',
    "            body = f'{MARKER}|pid={os.getpid()}|tmux={SESSION}|response=devbox-uat-http\\n'",
    "        encoded = body.encode('utf-8')",
    '        self.send_response(200)',
    "        self.send_header('Content-Type', 'text/plain')",
    "        self.send_header('Content-Length', str(len(encoded)))",
    '        self.end_headers()',
    '        self.wfile.write(encoded)',
    '    def log_message(self, *_args):',
    '        pass',
    "server = http.server.ThreadingHTTPServer(('0.0.0.0', 4173), Handler)",
    "print(f'{MARKER} PID={os.getpid()} TMUX={SESSION}', flush=True)",
    'server.serve_forever()',
  ].join('\n');
  const encoded = Buffer.from(code).toString('base64');
  return `python3 -c "$(printf '%s' '${encoded}' | base64 -d)"\n`;
}

function remoteDetachedProcessCommand(started, completion, path) {
  const startedEncoded = Buffer.from(started).toString('base64');
  const completionEncoded = Buffer.from(completion).toString('base64');
  return `rm -f -- ${shellQuote(path)}; printf '%s\\n' "$(printf '%s' '${completionEncoded}' | base64 -d)" > ${shellQuote(path)}; (sh -c 'while :; do sleep 30; done' ${shellQuote(completion)}) >/dev/null 2>&1 & printf '%s PID=%s MARKER=%s\\n' "$(printf '%s' '${startedEncoded}' | base64 -d)" "$!" "$(printf '%s' '${completionEncoded}' | base64 -d)"\n`;
}

function remoteSnapshotStateCommand(sentinelPresent, sentinelMissing, processPresent, processAbsent, path, marker, pid) {
  const sentinelPresentEncoded = Buffer.from(sentinelPresent).toString('base64');
  const sentinelMissingEncoded = Buffer.from(sentinelMissing).toString('base64');
  const processPresentEncoded = Buffer.from(processPresent).toString('base64');
  const processAbsentEncoded = Buffer.from(processAbsent).toString('base64');
  return `if [ -f ${shellQuote(path)} ] && grep -Fqx ${shellQuote(marker)} ${shellQuote(path)}; then printf '%s\\n' "$(printf '%s' '${sentinelPresentEncoded}' | base64 -d)"; else printf '%s\\n' "$(printf '%s' '${sentinelMissingEncoded}' | base64 -d)"; fi; if kill -0 '${pid}' 2>/dev/null && [ -r '/proc/${pid}/cmdline' ] && tr '\\0' ' ' < '/proc/${pid}/cmdline' | grep -Fq ${shellQuote(marker)}; then printf '%s\\n' "$(printf '%s' '${processPresentEncoded}' | base64 -d)"; else printf '%s\\n' "$(printf '%s' '${processAbsentEncoded}' | base64 -d)"; fi\n`;
}

function parseIdentity(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped} PID=([0-9]+) TMUX=([^\\s\\r\\n]+) SOCKET=([^\\s\\r\\n]+)`).exec(output);
  if (!match) throw new Error(`identity marker ${marker} did not include a PID, tmux session, and socket`);
  return { pid: match[1], session: match[2], socket: match[3] };
}

function parseFixtureStartup(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + ' PID=([0-9]+) TMUX=([^\\s\\r\\n]+)').exec(output);
  if (!match) throw new Error('fixture marker did not include a PID and tmux session');
  return { marker, pid: match[1], session: match[2] };
}

function parseDetachedProcessStartup(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + ' PID=([0-9]+) MARKER=([^\\s\\r\\n]+)').exec(output);
  if (!match) throw new Error('detached process marker did not include a PID and process marker');
  return { marker: match[2], pid: match[1] };
}

async function waitForFixture(url, marker) {
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/', url));
      const body = await response.text();
      if (!response.ok) throw new Error('HTTP fixture returned status ' + response.status);
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(
        escaped + '\\|pid=([0-9]+)\\|tmux=([^|\\s]+)\\|response=([^|\\s]+)',
      ).exec(body);
      if (!match) throw new Error('HTTP fixture response did not include its identity');
      return { marker, pid: match[1], session: match[2], response: match[3] };
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError ?? new Error('HTTP fixture marker timeout');
}

async function stopFixture(url, marker) {
  const response = await fetch(new URL('/shutdown', url));
  const body = await response.text();
  if (!response.ok || body !== 'fixture-stopping\n') throw new Error('HTTP fixture did not accept shutdown');
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(new URL('/', url));
      const probeBody = await probe.text();
      if (!probe.ok || !probeBody.includes(marker)) return;
    } catch {
      return;
    }
    await delay(250);
  }
  throw new Error('HTTP fixture did not stop');
}

function publicRoute(output, port) {
  const match = routeMatch(output, port);
  if (!match) throw new Error('CLI output did not include the public route for port ' + port);
  return match[1];
}

function hasPublicRoute(output, port) {
  return Boolean(routeMatch(output, port));
}

function routeMatch(output, port) {
  return new RegExp('^\\s*' + port + ':\\s+(https://[^\\s]+)\\s+\\(', 'm').exec(output);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function markerFor(label) {
  return `DEVBOX_UAT_${label}_${randomBytes(8).toString('hex')}`;
}

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail: redact(detail) });
  if (!ok) throw new Error(`${name} failed`);
}

async function writeReport() {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function matches(output, pattern) {
  if (typeof pattern === 'string') return output.includes(pattern) ? pattern : undefined;
  return pattern.test(output) ? pattern : undefined;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function redact(value) {
  let result = String(value);
  for (const secret of secrets) {
    result = result.split(secret).join('[REDACTED]');
    result = result.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return result.replace(/(authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]').slice(0, 300);
}

function fingerprint(value) {
  return Buffer.from(value).toString('base64url').slice(0, 16);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function signalCode(signal) {
  return signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 1;
}
