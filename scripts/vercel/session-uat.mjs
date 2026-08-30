#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Sandbox, Snapshot } from '@vercel/sandbox';

const execFile = promisify(execFileCallback);

const APP_PORT = 4173;
const DURATION_TIMEOUT_MINUTES = 60;
const DURATION_IDLE_BOUNDARY_MS = positiveInteger('DEVBOX_UAT_IDLE_BOUNDARY_MS', 15 * 60 * 1000);
const DURATION_FINAL_WINDOW_MS = positiveInteger('DEVBOX_UAT_FINAL_WINDOW_MS', 60 * 1000);
const DURATION_STOP_TIMEOUT_MS = positiveInteger('DEVBOX_UAT_STOP_TIMEOUT_MS', 180 * 1000);
const DURATION_PROVIDER_POLL_MS = positiveInteger('DEVBOX_UAT_PROVIDER_POLL_MS', 2 * 1000);
const DEADLINE_TOLERANCE_MS = 5 * 1000;
const RUN_BRANCH_TAG_PREFIX = 'uat-devbox-session-';
const MODE = process.argv[2] === '--cleanup'
  ? 'cleanup'
  : process.env.DEVBOX_UAT_MODE ?? 'reconnect';
const REPO_ROOT = process.env.DEVBOX_UAT_REPO_ROOT ?? process.cwd();
const BRANCH = required('DEVBOX_UAT_BRANCH');
const CLI_PATH = resolve(process.env.DEVBOX_CLI ?? 'dist/cli.js');
const REPORT_PATH = process.env.DEVBOX_UAT_REPORT ?? resolve('uat-evidence/session-uat.json');
const STATE_HOME = process.env.DEVBOX_UAT_STATE_HOME;
const TIMEOUT_MINUTES = positiveInteger('DEVBOX_UAT_TIMEOUT_MINUTES', 60);
const CLI_TIMEOUT_MS = positiveInteger('DEVBOX_UAT_CLI_TIMEOUT_MS', 120_000);
const MARKER_TIMEOUT_MS = positiveInteger('DEVBOX_UAT_MARKER_TIMEOUT_MS', 45_000);
const secrets = [...new Set(Object.entries(process.env)
  .filter(([name, value]) => /TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|TEAM_ID|PROJECT_ID|PRIVATE_KEY|ENV_CONTENT|^DEVBOX_GITHUB_FIXTURE_/i.test(name) && value)
  .map(([, value]) => value))]
  .sort((left, right) => right.length - left.length);

let cleanupDependenciesPromise;
let identityFactoryPromise;
const workflowRunStates = new Map();

const report = {
  schemaVersion: 1,
  redacted: false,
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
  if (!process.env.DEVBOX_UAT_REPO_ROOT) {
    throw new Error('DEVBOX_UAT_REPO_ROOT is required for session UAT');
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
    if (active) {
      try {
        await active.close('SIGTERM');
      } catch {
        report.terminalCloseError = 'CLI terminal cleanup did not complete';
      }
    }
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
  check('duration idle deadline unchanged', sameDeadline(provider.expiresAt, idleProvider.expiresAt), `initial=${provider.expiresAt}; idle=${idleProvider.expiresAt}`);
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
  check('duration final deadline unchanged', sameDeadline(provider.expiresAt, finalProvider.expiresAt), `initial=${provider.expiresAt}; final=${finalProvider.expiresAt}`);
  const finalResponse = await waitForFixture(reconnect.publicUrl, reconnect.fixtureMarker);
  const remainingMs = expiresAtMs - Date.now();
  check('duration final HTTP response', finalResponse.pid === reconnect.startedIdentity.pid, `initial=${reconnect.startedIdentity.pid}; final=${finalResponse.pid}`);
  check('duration final HTTP marker', finalResponse.marker === reconnect.fixtureMarker, 'fixture remained reachable in the final lease window');
  check('duration final HTTP payload', finalResponse.response === 'devbox-uat-http', 'fixture returned the expected payload in the final lease window');
  check('duration final lease window', remainingMs >= 0 && remainingMs <= DURATION_FINAL_WINDOW_MS, `remaining=${remainingMs}ms`);

  await stopFixture(reconnect.publicUrl, reconnect.fixtureMarker);
  const stopped = await waitForProviderStop(provider.sandboxName, DURATION_STOP_TIMEOUT_MS);
  const stoppedAtMs = Date.parse(stopped.terminalAt);
  check('duration natural stop boundary', Number.isFinite(stoppedAtMs)
    && stoppedAtMs >= expiresAtMs - DEADLINE_TOLERANCE_MS
    && stoppedAtMs <= expiresAtMs + DEADLINE_TOLERANCE_MS, `deadline=${provider.expiresAt}; stoppedAt=${stopped.terminalAt}`);
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
    idleExpiresAt: idleProvider.expiresAt,
    finalStatus: finalProvider.status,
    finalSessionId: finalProvider.sessionId,
    finalExpiresAt: finalProvider.expiresAt,
    idleBoundaryAt: new Date(idleBoundaryAt).toISOString(),
    quietStartedAt: new Date(quietStartedAt).toISOString(),
    finalProbeAt,
    finalRemainingMs: remainingMs,
    deadlineToleranceMs: DEADLINE_TOLERANCE_MS,
    terminalAt: stopped.terminalAt,
    stoppedAt: stopped.stoppedAt,
    abortedAt: stopped.abortedAt,
    stopObservedAt: stopped.observedAt,
    stoppedStatus: stopped.status,
    retainedSnapshots: retainedSnapshots.map((snapshot) => ({ id: snapshot.id, status: snapshot.status })),
    resumedSessionId: resumed.identity.sessionId,
    resumedSandboxName: resumed.identity.sandboxName,
  };
}

async function readProviderSessionFacts(stateHome, sandboxName = undefined) {
  const name = sandboxName ?? await readStoredSandboxName(stateHome);
  let sandbox;
  try {
    sandbox = await Sandbox.get({ ...providerCredentials(), name, resume: false });
  } catch {
    throw new Error('Vercel provider session facts probe failed');
  }
  const current = sandbox.currentSession();
  if (!current?.sessionId) throw new Error('Vercel provider session facts did not include a session ID');
  return {
    sandboxName: sandbox.name,
    sessionId: current.sessionId,
    status: current.status,
    configuredTimeoutMs: current.timeout,
    createdAt: current.createdAt.toISOString(),
    expiresAt: sandbox.expiresAt?.toISOString() ?? null,
    stoppedAt: current.stoppedAt?.toISOString() ?? null,
    abortedAt: current.abortedAt?.toISOString() ?? null,
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
  try {
    const page = await Snapshot.list({ ...providerCredentials(), name: sandboxName, limit: 50 });
    return page.toArray();
  } catch {
    throw new Error('Vercel provider snapshot probe failed');
  }
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
  if (lastError) throw new Error('Vercel provider snapshot probe did not converge');
  throw new Error(`Vercel provider did not retain exactly one created snapshot; found ${snapshots.filter((snapshot) => snapshot.status === 'created').length}`);
}

async function waitForProviderStop(sandboxName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let facts;
    try {
      facts = await readProviderSessionFacts(undefined, sandboxName);
    } catch {
      facts = undefined;
    }
    if (facts && ['stopped', 'aborted'].includes(facts.status)) {
      const terminalAt = facts.status === 'aborted' ? facts.abortedAt : facts.stoppedAt;
      if (terminalAt) return { ...facts, terminalAt, observedAt: new Date().toISOString() };
    }
    await delay(Math.min(DURATION_PROVIDER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Vercel provider Sandbox did not stop before the UAT deadline');
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

  let forcedProvider;
  const forcedAttach = await attachSession(stateHome);
  try {
    forcedProvider = await readProviderSessionFacts(stateHome, initial.provider.sandboxName);
    check('forced-close same provider session', forcedProvider.sessionId === initial.provider.sessionId, `initial=${initial.provider.sessionId}; reconnect=${forcedProvider.sessionId}`);
    check('forced-close same provider deadline', sameDeadline(forcedProvider.expiresAt, initial.provider.expiresAt), `initial=${initial.provider.expiresAt}; reconnect=${forcedProvider.expiresAt}`);
    const forcedResponse = await waitForFixture(initial.publicUrl, fixtureMarker);
    check('forced-close same foreground PID', forcedResponse.pid === startedIdentity.pid, `initial=${startedIdentity.pid}; reconnect=${forcedResponse.pid}`);
    check('forced-close same tmux session', forcedResponse.session === startedIdentity.session, `initial=${startedIdentity.session}; reconnect=${forcedResponse.session}`);
    check('forced-close same HTTP marker', forcedResponse.marker === fixtureMarker, 'fixture survived transport loss');
    check('forced-close same HTTP response', forcedResponse.response === 'devbox-uat-http', 'same fixture response returned after reconnect');
  } finally {
    await forcedAttach.close('SIGTERM');
  }

  let cleanProvider;
  const cleanAttach = await attachSession(stateHome);
  try {
    cleanProvider = await readProviderSessionFacts(stateHome, initial.provider.sandboxName);
    check('clean attach same provider session', cleanProvider.sessionId === initial.provider.sessionId, `initial=${initial.provider.sessionId}; attach=${cleanProvider.sessionId}`);
    check('clean attach same provider deadline', sameDeadline(cleanProvider.expiresAt, initial.provider.expiresAt), `initial=${initial.provider.expiresAt}; attach=${cleanProvider.expiresAt}`);
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
  if (!forcedProvider || !cleanProvider) throw new Error('reconnect provider identity was not recorded');
  report.reconnect = {
    fixtureMarker,
    initialPid: startedIdentity.pid,
    forcedClosePid: startedIdentity.pid,
    cleanAttachPid: startedIdentity.pid,
    tmuxSession: startedIdentity.session,
    initialSessionId: initial.provider.sessionId,
    forcedAttachSessionId: forcedProvider.sessionId,
    cleanAttachSessionId: cleanProvider.sessionId,
    initialExpiresAt: initial.provider.expiresAt,
    forcedAttachExpiresAt: forcedProvider.expiresAt,
    cleanAttachExpiresAt: cleanProvider.expiresAt,
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
  let session;
  let exitCode = null;
  try {
    session = createPty([CLI_PATH, BRANCH, '--provider', 'vercel', '--rm'], stateHome);
    exitCode = await session.waitForExit(CLI_TIMEOUT_MS);
  } catch {
    if (session) await session.close('SIGTERM').catch(() => undefined);
  }
  const output = session?.output() ?? '';
  const commandAccepted = session !== undefined
    && exitCode !== null
    && (exitCode === 0 || /No Vercel sandbox|No matching Vercel sandbox|nothing to remove/i.test(output));
  let runTagged;
  let runTaggedError;
  try {
    runTagged = await removeRunTaggedLeftovers();
  } catch {
    runTaggedError = 'run-tagged provider cleanup did not converge';
  }
  let inventory;
  let inventoryError;
  try {
    inventory = await waitForEmptyResourceInventory(DURATION_STOP_TIMEOUT_MS);
  } catch (error) {
    inventoryError = redact(error instanceof Error ? error.message : String(error));
  }
  const accepted = commandAccepted
    && runTagged?.accepted === true
    && inventory?.sandboxCount === 0
    && inventory.snapshotCount === 0;
  return {
    attempted: true,
    exitCode,
    accepted,
    commandAccepted,
    ...(commandAccepted ? {} : { commandError: 'CLI cleanup did not complete successfully' }),
    ...(runTagged === undefined ? {} : { runTagged }),
    ...(runTaggedError === undefined ? {} : { runTaggedError }),
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
  if (lastError) throw new Error('Vercel cleanup inventory probe did not converge');
  throw new Error(`Vercel cleanup inventory did not converge: sandboxes=${lastInventory.sandboxCount}; snapshots=${lastInventory.snapshotCount}`);
}

async function readResourceInventory() {
  const identity = await cleanupIdentity();
  const credentials = providerCredentials();
  const sandboxPage = await Sandbox.list({
    ...credentials,
    ...(identity.name === undefined ? {} : { namePrefix: identity.name }),
    tags: identity.tags,
    limit: 50,
  });
  const listed = await sandboxPage.toArray();
  const sandboxes = listed.filter((sandbox) => identity.name === undefined
    ? sandbox.tags?.provider === identity.tags.provider
      && sandbox.tags?.repository === identity.tags.repository
      && sandbox.tags?.branch === identity.tags.branch
    : sandbox.name === identity.name);
  const snapshotNames = identity.name === undefined
    ? sandboxes.map((sandbox) => sandbox.name)
    : [identity.name];
  let snapshotCount = 0;
  for (const name of snapshotNames) {
    try {
      const snapshotPage = await Snapshot.list({ ...credentials, name, limit: 50 });
      snapshotCount += (await snapshotPage.toArray()).filter((snapshot) => snapshot.status !== 'deleted').length;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { sandboxCount: sandboxes.length, snapshotCount };
}

async function cleanupIdentity() {
  const credentials = providerCredentials();
  const configuredRepository = process.env.DEVBOX_UAT_REPOSITORY?.trim();
  let remote = configuredRepository;
  if (!remote) {
    const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
    });
    remote = stdout.trim();
  } else if (!remote.includes('://') && !remote.startsWith('git@') && !remote.startsWith('ssh://')) {
    remote = `github.com/${remote.replace(/^\/+|\/+$/g, '')}`;
  }
  return createCleanupIdentity({
    remote,
    branch: BRANCH,
    scope: { teamId: credentials.teamId, projectId: credentials.projectId },
  });
}

async function createCleanupIdentity(input) {
  if (!identityFactoryPromise) {
    identityFactoryPromise = import('../../dist/providers/vercel/identity.js')
      .then((module) => module.createVercelIdentity)
      .catch(() => undefined);
  }
  const factory = await identityFactoryPromise;
  return factory ? factory(input) : fallbackCleanupIdentity(input);
}

function fallbackCleanupIdentity(input) {
  const repository = fallbackGitHubRemote(input.remote);
  const branch = input.branch.trim();
  const canonical = `${repository.host}/${repository.owner}/${repository.repository}`;
  return {
    repository,
    canonicalRepository: canonical,
    branch,
    name: undefined,
    tags: {
      provider: 'vercel',
      repository: appendFallbackHash(`github-com-${repository.owner}-${repository.repository}`, canonical),
      branch: appendFallbackHash(branch, branch),
    },
  };
}

function fallbackGitHubRemote(remote) {
  const path = remote.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length !== 2) throw new Error('Vercel UAT repository must identify one GitHub owner and repository');
  return {
    host: 'github.com',
    owner: segments[0].toLowerCase(),
    repository: segments[1].toLowerCase(),
    canonical: `github.com/${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`,
  };
}

function appendFallbackHash(value, source) {
  const suffix = `-${shortHash(source)}`;
  const available = 63 - suffix.length;
  return `${sanitizeFallbackName(value).slice(0, available).replace(/-+$/g, '')}${suffix}`;
}

function sanitizeFallbackName(value) {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'devbox';
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isNotFound(error) {
  return error?.status === 404 || error?.response?.status === 404 || error?.notFound === true;
}

async function cleanupDependencies() {
  if (!cleanupDependenciesPromise) {
    cleanupDependenciesPromise = Promise.all([
      import('../../dist/providers/vercel/client.js'),
      import('../../dist/providers/vercel/cleanup.js'),
    ]).then(([clientModule, cleanupModule]) => ({
      client: clientModule.createVercelSandboxClient(),
      cleanup: cleanupModule.cleanupVercelSandbox,
    })).catch(() => ({
      client: createDirectCleanupClient(),
      cleanup: undefined,
    }));
  }
  return cleanupDependenciesPromise;
}

function createDirectCleanupClient() {
  return {
    async listSandboxes({ credentials, tags }) {
      const page = await Sandbox.list({ ...credentials, tags, limit: 50 });
      const records = await page.toArray();
      return records.filter((record) => Object.entries(tags ?? {}).every(([key, value]) => record.tags?.[key] === value));
    },
    async listSnapshots({ credentials, name }) {
      const page = await Snapshot.list({ ...credentials, name, limit: 50 });
      return page.toArray();
    },
    get: (request) => Sandbox.get(request),
    listSessions: (sandbox, options) => sandbox.listSessions(options),
    stopSandbox: (sandbox, options) => sandbox.stop(options),
    deleteSandbox: (sandbox, options) => sandbox.delete(options),
    deleteSandboxByName: async ({ credentials, name, signal }) => {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name, resume: false, signal });
        await sandbox.delete({ signal });
        return { missing: false };
      } catch (error) {
        if (isNotFound(error)) return { missing: true };
        throw error;
      }
    },
  };
}

async function fallbackCleanupSandbox(record, expectedTags) {
  const credentials = providerCredentials();
  let sandbox;
  try {
    sandbox = await Sandbox.get({ ...credentials, name: record.name, resume: false });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (sandbox && (sandbox.name !== record.name || JSON.stringify(cleanupTags(sandbox.tags)) !== JSON.stringify(expectedTags))) {
    return { verified: false, errors: ['sandbox identity verification failed'] };
  }
  if (sandbox) {
    try {
      let sessions = await (await sandbox.listSessions()).toArray();
      if (sessions.some((session) => !['stopped', 'aborted'].includes(session.status))) {
        await sandbox.stop();
        sessions = await (await sandbox.listSessions()).toArray();
        if (sessions.some((session) => !['stopped', 'aborted'].includes(session.status))) {
          return { verified: false, errors: ['sandbox sessions remained non-terminal after stop'] };
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      await sandbox.delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  let snapshots = [];
  try {
    snapshots = await (await Snapshot.list({ ...credentials, name: record.name, limit: 50 })).toArray();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  for (const snapshot of snapshots.filter((candidate) => candidate.status !== 'deleted')) {
    try {
      const handle = await Snapshot.get({ ...credentials, snapshotId: snapshot.id });
      await handle.delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const remainingSnapshots = await (await Snapshot.list({ ...credentials, name: record.name, limit: 50 })).toArray();
  if (remainingSnapshots.some((snapshot) => snapshot.status !== 'deleted')) {
    return { verified: false, errors: ['snapshot remained after direct cleanup'] };
  }
  if (!sandbox) return { verified: true, errors: [] };
  try {
    await Sandbox.get({ ...credentials, name: record.name, resume: false });
    return { verified: false, errors: ['sandbox remained after direct cleanup'] };
  } catch (error) {
    return isNotFound(error)
      ? { verified: true, errors: [] }
      : { verified: false, errors: ['direct cleanup verification failed'] };
  }
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

async function listRunTaggedSandboxes(identity) {
  const { client } = await cleanupDependencies();
  const records = await client.listSandboxes({
    credentials: providerCredentials(),
    tags: { provider: 'vercel', repository: identity.tags.repository },
  });
  const candidates = records.filter((record) => record.tags?.provider === 'vercel'
    && record.tags.repository === identity.tags.repository
    && typeof record.tags.branch === 'string'
    && record.tags.branch.startsWith(RUN_BRANCH_TAG_PREFIX));
  const eligible = [];
  for (const record of candidates) {
    if (record.tags.branch === identity.tags.branch || await completedWorkflowRun(record.tags.branch)) {
      eligible.push(record);
    }
  }
  return eligible;
}

async function completedWorkflowRun(branchTag) {
  const normalizedTag = branchTag.replace(/-[a-f0-9]{16}$/, '');
  const match = new RegExp(`^${RUN_BRANCH_TAG_PREFIX}(\\d+)-(\\d+)$`).exec(normalizedTag);
  if (!match) return false;
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) return false;
  const runId = match[1];
  const runAttempt = Number(match[2]);
  const cached = workflowRunStates.get(runId);
  if (cached !== undefined) return cached;
  const token = process.env.GITHUB_TOKEN?.trim();
  let completed = false;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const run = await response.json();
      completed = run?.status === 'completed' && Number(run?.run_attempt) === runAttempt;
    }
  } catch {
    completed = false;
  }
  workflowRunStates.set(runId, completed);
  return completed;
}

function cleanupTags(tags) {
  const keys = ['provider', 'repository', 'branch', 'version', 'identity'];
  if (!tags || keys.some((key) => typeof tags[key] !== 'string' || tags[key].length === 0)) return undefined;
  return Object.fromEntries(keys.map((key) => [key, tags[key]]));
}

async function readRunTaggedResourceInventory(identity, knownNames) {
  const { client } = await cleanupDependencies();
  const records = await listRunTaggedSandboxes(identity);
  const names = new Set([...knownNames, ...records.map((record) => record.name)]);
  let snapshotCount = 0;
  for (const name of names) {
    let snapshots;
    try {
      snapshots = await client.listSnapshots({
        credentials: providerCredentials(),
        name,
      });
    } catch (error) {
      if (error?.status === 404 || error?.notFound === true) continue;
      throw error;
    }
    snapshotCount += snapshots.filter((snapshot) => snapshot.status !== 'deleted').length;
  }
  return { sandboxCount: records.length, snapshotCount };
}

async function waitForRunTaggedEmpty(identity, knownNames, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastInventory = { sandboxCount: -1, snapshotCount: -1 };
  while (Date.now() < deadline) {
    try {
      lastInventory = await readRunTaggedResourceInventory(identity, knownNames);
      if (lastInventory.sandboxCount === 0 && lastInventory.snapshotCount === 0) return lastInventory;
    } catch {
      // Provider inventory is eventually consistent.
    }
    await delay(Math.min(DURATION_PROVIDER_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Vercel run-tagged cleanup inventory did not converge: sandboxes=${lastInventory.sandboxCount}; snapshots=${lastInventory.snapshotCount}`);
}

async function removeRunTaggedLeftovers() {
  const dependencies = await cleanupDependencies();
  const { client, cleanup } = dependencies;
  const identity = await cleanupIdentity();
  const records = await listRunTaggedSandboxes(identity);
  const targets = new Map(records.map((record) => [record.name, record]));
  if (identity.name !== undefined && !targets.has(identity.name)) {
    targets.set(identity.name, { name: identity.name, tags: identity.tags });
  }
  const knownNames = new Set(targets.keys());
  let removedCount = 0;
  let residualCount = 0;
  for (const record of targets.values()) {
    const expectedTags = cleanupTags(record.tags);
    if (!expectedTags) {
      residualCount += 1;
      continue;
    }
    try {
      const result = cleanup
        ? await cleanup({
          name: record.name,
          credentials: providerCredentials(),
          expectedTags,
          ...(record.currentSnapshotId === undefined ? {} : { knownSnapshotIds: [record.currentSnapshotId] }),
          adapter: cleanupAdapter(client),
          timeoutMs: DURATION_STOP_TIMEOUT_MS,
          maxAttempts: 8,
        })
        : await fallbackCleanupSandbox(record, expectedTags);
      if (result.verified && result.errors.length === 0) removedCount += 1;
      else residualCount += 1;
    } catch {
      residualCount += 1;
    }
  }
  const inventory = await waitForRunTaggedEmpty(identity, knownNames, DURATION_STOP_TIMEOUT_MS);
  return {
    accepted: residualCount === 0 && inventory.sandboxCount === 0 && inventory.snapshotCount === 0,
    removedCount,
    residualCount,
    inventory,
  };
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
    const displayUrl = publicRoute(resumed.output(), 6080);
    const appUrl = publicRoute(resumed.output(), APP_PORT);
    const displayProbe = await waitForPublicRoute(displayUrl);
    const displayHealthy = displayProbe.reachable && displayProbe.status >= 200 && displayProbe.status < 400;
    check('snapshot display route healthy', displayHealthy, `status=${displayProbe.status}`);
    const freshIdentity = await readIdentity(resumed, 'snapshot-attach');
    const socketChanged = freshIdentity.socket !== priorIdentity.socket;
    check('snapshot fresh socket', socketChanged, 'snapshot resume received a new session-derived socket');
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
    const sentinelRestored = sentinelState.match === sentinelPresent;
    check('snapshot sentinel restored', sentinelRestored, `sentinel=${sentinelState.match}`);
    const processState = await resumed.waitForAny([processPresent, processAbsent], MARKER_TIMEOUT_MS);
    const priorProcessEnded = processState.match === processAbsent;
    check('snapshot prior process ended', priorProcessEnded, `priorPid=${priorProcess.pid}`);
    const workspaceMarker = markerFor('snapshot-workspace');
    resumed.write(remoteWorkspaceCommand(workspaceMarker));
    const workspace = parseWorkspace(
      await resumed.waitFor(workspaceMarker, MARKER_TIMEOUT_MS),
      workspaceMarker,
    );
    const workspaceRestored = workspace.path.startsWith('/vercel/sandbox/');
    check('snapshot workspace restored', workspaceRestored, `path=${workspace.path}`);
    check('snapshot branch restored', workspace.branch === BRANCH, `branch=${workspace.branch}`);
    const runtimeReady = markerFor('snapshot-runtime-ready');
    const runtimeMissing = markerFor('snapshot-runtime-missing');
    const provider = await readProviderSessionFacts(stateHome);
    resumed.write(remoteRuntimeStateCommand(runtimeReady, runtimeMissing, provider.sessionId));
    const runtimeState = await resumed.waitForAny([runtimeReady, runtimeMissing], MARKER_TIMEOUT_MS);
    const runtimeServicesRefreshed = runtimeState.match === runtimeReady;
    check('snapshot runtime state restored', runtimeServicesRefreshed, `runtime=${runtimeState.match}`);
    const processBoundaryNotice = resumed.output().includes('prior user processes ended');
    check('snapshot process boundary notice', processBoundaryNotice, 'attach reported the process boundary');
    const snapshotFixtureMarker = markerFor('snapshot-http-fixture');
    resumed.write(remoteHttpFixtureCommand(snapshotFixtureMarker));
    const snapshotFixtureIdentity = parseFixtureStartup(
      await resumed.waitFor(snapshotFixtureMarker, MARKER_TIMEOUT_MS),
      snapshotFixtureMarker,
    );
    check('snapshot new HTTP fixture session', snapshotFixtureIdentity.session === 'devbox', `session=${snapshotFixtureIdentity.session}`);
    const snapshotResponse = await waitForFixture(appUrl, snapshotFixtureMarker);
    const appProbe = await waitForPublicRoute(appUrl);
    const appHealthy = appProbe.reachable && appProbe.status >= 200 && appProbe.status < 400;
    check('snapshot public route healthy', appHealthy, `status=${appProbe.status}`);
    check('snapshot public route fixture', snapshotResponse.response === 'devbox-uat-http', 'new fixture returned the expected payload');
    await stopFixture(appUrl, snapshotFixtureMarker);
    resumed.write(Buffer.from([0x1d]));
    await resumed.waitForExit(CLI_TIMEOUT_MS);
    const providerSessionChanged = provider.sessionId !== priorIdentity.providerSessionId;
    check('snapshot fresh provider session', providerSessionChanged, `prior=${priorIdentity.providerSessionId}; resumed=${provider.sessionId}`);
    check('snapshot resumed timeout', provider.configuredTimeoutMs === TIMEOUT_MINUTES * 60 * 1000, `timeout=${provider.configuredTimeoutMs}ms`);
    report.snapshot = {
      notice: processBoundaryNotice,
      socketChanged,
      priorProcessPid: priorProcess.pid,
      priorProcessEnded,
      sentinelRestored,
      runtimeServicesRefreshed,
      workspacePath: workspace.path,
      branch: workspace.branch,
      displayRouteStatus: displayProbe.status,
      appRouteStatus: appProbe.status,
      fixturePid: snapshotFixtureIdentity.pid,
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

function remoteWorkspaceCommand(marker) {
  const encoded = Buffer.from(marker).toString('base64');
  return `printf '%s PWD=%s BRANCH=%s\\n' "$(printf '%s' '${encoded}' | base64 -d)" "$PWD" "$(git branch --show-current)"\n`;
}

function remoteRuntimeStateCommand(ready, missing, sessionId) {
  const readyEncoded = Buffer.from(ready).toString('base64');
  const missingEncoded = Buffer.from(missing).toString('base64');
  return `if [ -s '/vercel/.devbox/runtime/preparation.json' ] && grep -Fq ${shellQuote(sessionId)} '/vercel/.devbox/runtime/preparation.json' && [ -s '/vercel/.devbox/runtime/setup.status' ] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"(running|succeeded)"' '/vercel/.devbox/runtime/setup.status'; then printf '%s\\n' "$(printf '%s' '${readyEncoded}' | base64 -d)"; else printf '%s\\n' "$(printf '%s' '${missingEncoded}' | base64 -d)"; fi\n`;
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

function parseWorkspace(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + ' PWD=([^\\s\\r\\n]+) BRANCH=([^\\s\\r\\n]+)').exec(output);
  if (!match) throw new Error('workspace marker did not include the working directory and branch');
  return { path: match[1], branch: match[2] };
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
      return { marker, pid: match[1], session: match[2], response: match[3], status: response.status };
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

async function waitForPublicRoute(url) {
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now()))),
      });
      return { reachable: true, status: response.status };
    } catch {
      await delay(250);
    }
  }
  throw new Error('public route did not respond before the deadline');
}

function publicRoute(output, port) {
  const match = routeMatch(output, port);
  if (!match) throw new Error('CLI output did not include the public route for port ' + port);
  return match[1];
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
  return result
    .replace(/(authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp_|github_pat_|vcp_|vercel_)[A-Za-z0-9_~-]+/gi, '[REDACTED]')
    .replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(devbox_novnc=)[^;\s"']+/gi, '$1[REDACTED]')
    .replace(/(VERCEL_(?:TOKEN|OIDC_TOKEN|PASSWORD)\s*[=:]\s*)[^\s,}]+/gi, '$1[REDACTED]')
    .slice(0, 300);
}

function sameDeadline(expected, actual) {
  const expectedMs = Date.parse(expected ?? '');
  const actualMs = Date.parse(actual ?? '');
  return Number.isFinite(expectedMs)
    && Number.isFinite(actualMs)
    && Math.abs(expectedMs - actualMs) <= DEADLINE_TOLERANCE_MS;
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
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
