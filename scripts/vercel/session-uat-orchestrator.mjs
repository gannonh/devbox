import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSessionUatCleanup } from './session-uat-cleanup.mjs';
import { createEvidence, positiveInteger, required } from './session-uat-evidence.mjs';
import { createSessionUatProbes } from './session-uat-probes.mjs';

const APP_PORT = 4173;
const DURATION_TIMEOUT_MINUTES = 60;
const DURATION_IDLE_BOUNDARY_MS = 15 * 60 * 1000;
const DURATION_FINAL_WINDOW_MS = 60 * 1000;
const DURATION_STOP_TIMEOUT_MS = 180 * 1000;
const DURATION_PROVIDER_POLL_MS = 2 * 1000;
const DEADLINE_TOLERANCE_MS = 5 * 1000;
const RUN_BRANCH_TAG_PREFIX = 'uat-devbox-session-';

export async function runSessionUat({ environment = process.env, argv = process.argv } = {}) {
  const mode = argv[2] === '--cleanup' ? 'cleanup' : environment.DEVBOX_UAT_MODE ?? 'reconnect';
  const repoRoot = environment.DEVBOX_UAT_REPO_ROOT ?? process.cwd();
  const branch = required('DEVBOX_UAT_BRANCH', environment);
  const cliPath = resolve(environment.DEVBOX_CLI ?? 'dist/cli.js');
  const reportPath = environment.DEVBOX_UAT_REPORT ?? resolve('uat-evidence/session-uat.json');
  const stateHomePath = environment.DEVBOX_UAT_STATE_HOME;
  const timeoutMinutes = positiveInteger('DEVBOX_UAT_TIMEOUT_MINUTES', 60, environment);
  const cliTimeoutMs = positiveInteger('DEVBOX_UAT_CLI_TIMEOUT_MS', 120_000, environment);
  const markerTimeoutMs = positiveInteger('DEVBOX_UAT_MARKER_TIMEOUT_MS', 45_000, environment);
  const durationIdleBoundaryMs = positiveInteger('DEVBOX_UAT_IDLE_BOUNDARY_MS', DURATION_IDLE_BOUNDARY_MS, environment);
  const durationFinalWindowMs = positiveInteger('DEVBOX_UAT_FINAL_WINDOW_MS', DURATION_FINAL_WINDOW_MS, environment);
  const durationStopTimeoutMs = positiveInteger('DEVBOX_UAT_STOP_TIMEOUT_MS', DURATION_STOP_TIMEOUT_MS, environment);
  const durationProviderPollMs = positiveInteger('DEVBOX_UAT_PROVIDER_POLL_MS', DURATION_PROVIDER_POLL_MS, environment);
  const evidence = createEvidence({
    mode,
    branch,
    timeoutMinutes,
    reportPath,
    deadlineToleranceMs: DEADLINE_TOLERANCE_MS,
    environment,
  });
  const { report, redact, redactTail, fingerprint, check, sameDeadline, writeReport } = evidence;
  const probes = createSessionUatProbes({
    branch,
    repoRoot,
    cliPath,
    environment,
    markerTimeoutMs,
    providerPollMs: durationProviderPollMs,
    redact,
  });
  const cleanup = createSessionUatCleanup({
    branch,
    repoRoot,
    credentials: probes.providerCredentials(environment),
    configuredRepository: environment.DEVBOX_UAT_REPOSITORY,
    workflowRepository: environment.GITHUB_REPOSITORY?.trim(),
    workflowToken: environment.GITHUB_TOKEN?.trim(),
    cliTimeoutMs,
    stopTimeoutMs: durationStopTimeoutMs,
    pollMs: durationProviderPollMs,
    runBranchTagPrefix: RUN_BRANCH_TAG_PREFIX,
    redact,
  });
  const {
    attachSession,
    createPty,
    markerFor,
    parseDetachedProcessStartup,
    parseFixtureStartup,
    parseIdentity,
    parseWorkspace,
    publicRoute,
    readIdentity,
    readProviderSessionFacts,
    remoteDetachedProcessCommand,
    remoteHttpFixtureCommand,
    remoteIdentityCommand,
    remoteRuntimeStateCommand,
    remoteSnapshotStateCommand,
    remoteWorkspaceCommand,
    sessionSocketPath,
    stopFixture,
    waitForDeadline,
    waitForFixture,
    waitForProviderStop,
    waitForPublicRoute,
    waitForRetainedSnapshots,
  } = probes;
  let ownedStateHome = false;
  let activeStateHome;

  try {
    const stateHome = await stateDirectory();
    if (mode === 'cleanup') {
      report.cleanup = await runCleanup(stateHome);
      return report.cleanup.accepted ? 0 : 1;
    }
    if (!environment.DEVBOX_UAT_REPO_ROOT) {
      throw new Error('DEVBOX_UAT_REPO_ROOT is required for session UAT');
    }
    if (mode === 'duration' && timeoutMinutes !== DURATION_TIMEOUT_MINUTES) {
      throw new Error(`duration UAT requires a ${DURATION_TIMEOUT_MINUTES}-minute Sandbox lease`);
    }

    const preflight = await runCleanup(stateHome);
    report.preflight = { attempted: true, ...preflight };
    if (!preflight.accepted) throw new Error(`preflight cleanup failed with exit code ${preflight.exitCode}`);

    let active;
    try {
      active = await startSession(stateHome);
      const initialIdentity = await verifyInitialSession(active);
      if (mode === 'duration') await verifyDurationSession(stateHome, active, initialIdentity);
      else await verifyReconnectSession(stateHome, active, initialIdentity);
    } finally {
      if (active) {
        try {
          await active.close('SIGTERM');
        } catch {
          report.terminalCloseError = 'CLI terminal cleanup did not complete';
        }
      }
      const finalCleanup = await runCleanup(stateHome);
      report.cleanup = { attempted: true, ...finalCleanup };
      if (!finalCleanup.accepted) report.failed = true;
    }
    return report.checks.every((entry) => entry.ok) && report.cleanup.accepted ? 0 : 1;
  } catch (error) {
    report.error = redactTail(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.failed = report.failed === true || report.error !== undefined;
    await writeReport();
    if (ownedStateHome) await rm(activeStateHome, { recursive: true, force: true });
  }

  async function stateDirectory() {
    if (stateHomePath) {
      await mkdir(stateHomePath, { recursive: true });
      activeStateHome = stateHomePath;
      return stateHomePath;
    }
    const temporaryHome = await mkdtemp('/tmp/devbox-session-uat-state-');
    ownedStateHome = true;
    activeStateHome = temporaryHome;
    return temporaryHome;
  }

  async function startSession(stateHome) {
    const args = [
      cliPath,
      branch,
      '--provider',
      'vercel',
      ...(mode === 'duration' ? ['--timeout', String(timeoutMinutes)] : []),
      '--expose-ports',
      '4173',
    ];
    const session = createPty(args, stateHome);
    try {
      const first = await session.waitForAny([
        'Create this Vercel sandbox?',
        `session duration: ${timeoutMinutes} minutes`,
      ], cliTimeoutMs);
      if (first.match === 'Create this Vercel sandbox?') session.write('y\n');
      await session.waitFor(`session duration: ${timeoutMinutes} minutes`, cliTimeoutMs);
      return {
        ...session,
        publicUrl: publicRoute(session.output(), APP_PORT),
        provider: await readProviderSessionFacts(stateHome),
      };
    } catch (error) {
      await session.close('SIGTERM').catch(() => undefined);
      const detail = redactTail(session.output());
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ''}`);
    }
  }

  async function verifyInitialSession(session) {
    const marker = markerFor('identity');
    const identity = parseIdentity(await writeAndWait(session, remoteIdentityCommand(marker), marker, 2_000), marker);
    check('initial named tmux session', identity.session === 'devbox', `session=${identity.session}`);
    check('initial session socket', identity.socket.startsWith('/tmp/devbox-tmux/session-'), 'socket uses the devbox-owned session directory');
    check('initial socket matches provider session', identity.socket === sessionSocketPath(session.provider.sessionId), 'socket is derived from the current provider session ID');
    report.initial = {
      pid: identity.pid,
      tmuxSession: identity.session,
      socketFingerprint: fingerprint(identity.socket),
    };
    return identity;
  }

  async function verifyDurationSession(stateHome, session, initialIdentity) {
    const provider = session.provider;
    check('dedicated session duration', report.timeoutMinutes === DURATION_TIMEOUT_MINUTES, `timeout=${report.timeoutMinutes} minutes`);
    check('provider configured timeout', provider.configuredTimeoutMs === DURATION_TIMEOUT_MINUTES * 60 * 1000, `timeout=${provider.configuredTimeoutMs}ms`);
    check('provider session identity recorded', Boolean(provider.sandboxName && provider.sessionId), 'provider Sandbox name and session ID are present');
    check('provider creation time recorded', Number.isFinite(Date.parse(provider.createdAt)), `createdAt=${provider.createdAt}`);
    const expiresAtMs = Date.parse(provider.expiresAt ?? '');
    check('provider deadline recorded', Number.isFinite(expiresAtMs), `expiresAt=${provider.expiresAt}`);

    const snapshotProcess = await startSnapshotProcess(stateHome);
    const reconnect = await verifySameSessionReconnect(stateHome, session, 'duration-http-fixture');
    const quietStartedAt = Date.now();
    const idleBoundaryAt = await waitForDeadline(quietStartedAt + durationIdleBoundaryMs);
    const idleProvider = await readProviderSessionFacts(undefined, provider.sandboxName);
    check('duration idle provider session', idleProvider.status === 'running' && idleProvider.sessionId === provider.sessionId, `status=${idleProvider.status}; sessionFingerprint=${fingerprint(idleProvider.sessionId)}`);
    check('duration idle deadline unchanged', sameDeadline(provider.expiresAt, idleProvider.expiresAt), `initial=${provider.expiresAt}; idle=${idleProvider.expiresAt}`);
    const idleResponse = await waitForFixture(reconnect.publicUrl, reconnect.fixtureMarker);
    check('duration survives idle boundary', idleResponse.pid === reconnect.startedIdentity.pid, `initial=${reconnect.startedIdentity.pid}; idle=${idleResponse.pid}`);
    check('duration idle tmux session', idleResponse.session === reconnect.startedIdentity.session, `initial=${reconnect.startedIdentity.session}; idle=${idleResponse.session}`);
    check('duration idle HTTP marker', idleResponse.marker === reconnect.fixtureMarker, 'fixture remained reachable without terminal input');
    check('duration idle HTTP payload', idleResponse.response === 'devbox-uat-http', 'fixture returned the expected payload after the idle boundary');

    const finalProbeTarget = expiresAtMs - durationFinalWindowMs;
    check('duration final window is reachable', finalProbeTarget > Date.now(), 'final probe target is after the idle boundary');
    await waitForDeadline(finalProbeTarget);
    const finalProbeAt = new Date().toISOString();
    const finalProvider = await readProviderSessionFacts(undefined, provider.sandboxName);
    check('duration final provider session', finalProvider.status === 'running' && finalProvider.sessionId === provider.sessionId, `status=${finalProvider.status}; sessionFingerprint=${fingerprint(finalProvider.sessionId)}`);
    check('duration final deadline unchanged', sameDeadline(provider.expiresAt, finalProvider.expiresAt), `initial=${provider.expiresAt}; final=${finalProvider.expiresAt}`);
    const finalResponse = await waitForFixture(reconnect.publicUrl, reconnect.fixtureMarker);
    const remainingMs = expiresAtMs - Date.now();
    check('duration final HTTP response', finalResponse.pid === reconnect.startedIdentity.pid, `initial=${reconnect.startedIdentity.pid}; final=${finalResponse.pid}`);
    check('duration final HTTP marker', finalResponse.marker === reconnect.fixtureMarker, 'fixture remained reachable in the final lease window');
    check('duration final HTTP payload', finalResponse.response === 'devbox-uat-http', 'fixture returned the expected payload in the final lease window');
    check('duration final lease window', remainingMs >= 0 && remainingMs <= durationFinalWindowMs, `remaining=${remainingMs}ms`);

    await stopFixture(reconnect.publicUrl, reconnect.fixtureMarker);
    const stopped = await waitForProviderStop(provider.sandboxName, durationStopTimeoutMs);
    const stoppedAtMs = Date.parse(stopped.terminalAt);
    check('duration natural stop boundary', Number.isFinite(stoppedAtMs)
      && stoppedAtMs >= expiresAtMs - DEADLINE_TOLERANCE_MS
      && stoppedAtMs <= expiresAtMs + DEADLINE_TOLERANCE_MS, `deadline=${provider.expiresAt}; stoppedAt=${stopped.terminalAt}`);
    const retainedSnapshots = await waitForRetainedSnapshots(provider.sandboxName, durationStopTimeoutMs);
    const resumed = await resumeSnapshot(stateHome, snapshotProcess, {
      socket: initialIdentity.socket,
      providerSessionId: provider.sessionId,
      providerExpiresAt: provider.expiresAt,
    });
    check('duration provider stop observed', ['stopped', 'aborted'].includes(stopped.status), `status=${stopped.status}`);
    check('duration one retained snapshot', retainedSnapshots.length === 1, `createdSnapshots=${retainedSnapshots.length}`);
    report.duration = {
      configuredTimeoutMs: provider.configuredTimeoutMs,
      sessionIdFingerprint: fingerprint(provider.sessionId),
      sandboxNameFingerprint: fingerprint(provider.sandboxName),
      createdAt: provider.createdAt,
      expiresAt: provider.expiresAt,
      idleStatus: idleProvider.status,
      idleSessionIdFingerprint: fingerprint(idleProvider.sessionId),
      idleExpiresAt: idleProvider.expiresAt,
      finalStatus: finalProvider.status,
      finalSessionIdFingerprint: fingerprint(finalProvider.sessionId),
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
      retainedSnapshots: retainedSnapshots.map((snapshot) => ({ idFingerprint: fingerprint(snapshot.id), status: snapshot.status })),
      resumedSessionIdFingerprint: fingerprint(resumed.identity.sessionId),
      resumedSandboxNameFingerprint: fingerprint(resumed.identity.sandboxName),
    };
  }

  async function verifyReconnectSession(stateHome, initial, initialIdentity) {
    const reconnect = await verifySameSessionReconnect(stateHome, initial, 'http-fixture');
    await stopFixture(reconnect.publicUrl, reconnect.fixtureMarker);
    await verifySnapshotBoundary(stateHome, {
      socket: initialIdentity.socket,
      providerSessionId: initial.provider.sessionId,
      providerExpiresAt: initial.provider.expiresAt,
    });
  }

  async function verifySameSessionReconnect(stateHome, initial, label) {
    const fixtureMarker = markerFor(label);
    const startedIdentity = parseFixtureStartup(await writeAndWait(initial, remoteHttpFixtureCommand(fixtureMarker), fixtureMarker), fixtureMarker);
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
      check('forced-close same provider session', forcedProvider.sessionId === initial.provider.sessionId, `initialFingerprint=${fingerprint(initial.provider.sessionId)}; reconnectFingerprint=${fingerprint(forcedProvider.sessionId)}`);
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
      check('clean attach same provider session', cleanProvider.sessionId === initial.provider.sessionId, `initialFingerprint=${fingerprint(initial.provider.sessionId)}; attachFingerprint=${fingerprint(cleanProvider.sessionId)}`);
      check('clean attach same provider deadline', sameDeadline(cleanProvider.expiresAt, initial.provider.expiresAt), `initial=${initial.provider.expiresAt}; attach=${cleanProvider.expiresAt}`);
      const cleanResponse = await waitForFixture(initial.publicUrl, fixtureMarker);
      check('clean attach same foreground PID', cleanResponse.pid === startedIdentity.pid, `initial=${startedIdentity.pid}; attach=${cleanResponse.pid}`);
      check('clean attach same tmux session', cleanResponse.session === startedIdentity.session, `initial=${startedIdentity.session}; attach=${cleanResponse.session}`);
      check('clean attach same HTTP marker', cleanResponse.marker === fixtureMarker, 'fixture survived clean detach');
      check('clean attach same HTTP response', cleanResponse.response === 'devbox-uat-http', 'same fixture response returned after clean attach');
      cleanAttach.write(Buffer.from([0x1d]));
      const cleanExitCode = await cleanAttach.waitForExit(cliTimeoutMs);
      check('clean Ctrl-] detach', cleanExitCode === 0, `exitCode=${cleanExitCode}`);
    } finally {
      await cleanAttach.close('SIGTERM');
    }
    if (!forcedProvider || !cleanProvider) throw new Error('reconnect provider identity was not recorded');
    report.reconnect = {
      fixtureMarker,
      initialPid: startedIdentity.pid,
      forcedClosePid: startedIdentity.pid,
      cleanAttachPid: startedIdentity.pid,
      tmuxSession: startedIdentity.session,
      initialSessionIdFingerprint: fingerprint(initial.provider.sessionId),
      forcedAttachSessionIdFingerprint: fingerprint(forcedProvider.sessionId),
      cleanAttachSessionIdFingerprint: fingerprint(cleanProvider.sessionId),
      initialExpiresAt: initial.provider.expiresAt,
      forcedAttachExpiresAt: forcedProvider.expiresAt,
      cleanAttachExpiresAt: cleanProvider.expiresAt,
    };
    return { fixtureMarker, publicUrl: initial.publicUrl, startedIdentity };
  }

  async function runCleanup(stateHome) {
    return cleanup.runCleanup(async () => {
      let session;
      let exitCode = null;
      try {
        session = createPty([cliPath, branch, '--provider', 'vercel', '--rm'], stateHome);
        exitCode = await session.waitForExit(cliTimeoutMs);
      } catch {
        if (session) await session.close('SIGTERM').catch(() => undefined);
      }
      return { exitCode, output: session?.output() ?? '' };
    });
  }

  async function runAction(stateHome, args) {
    const session = createPty([cliPath, ...args], stateHome);
    try {
      const exitCode = await session.waitForExit(cliTimeoutMs);
      return { exitCode, output: session.output() };
    } catch (error) {
      await session.close('SIGTERM').catch(() => undefined);
      throw error;
    }
  }

  async function startSnapshotProcess(stateHome) {
    const session = await attachSession(stateHome);
    try {
      const startedMarker = markerFor('snapshot-process-started');
      const processMarker = markerFor('snapshot-process');
      const sentinelPath = `/vercel/sandbox/.devbox-uat-sentinel-${randomBytes(8).toString('hex')}`;
      const priorProcess = parseDetachedProcessStartup(
        await writeAndWait(session, remoteDetachedProcessCommand(startedMarker, processMarker, sentinelPath), startedMarker),
        startedMarker,
      );
      check('snapshot process marker recorded', priorProcess.marker === processMarker, 'the detached process carried a unique marker');
      session.write(Buffer.from([0x1d]));
      const exitCode = await session.waitForExit(cliTimeoutMs);
      check('snapshot process Ctrl-] detach', exitCode === 0, `exitCode=${exitCode}`);
      return { ...priorProcess, sentinelPath };
    } catch (error) {
      await session.close('SIGTERM').catch(() => undefined);
      throw error;
    }
  }

  async function verifySnapshotBoundary(stateHome, priorIdentity) {
    const priorProcess = await startSnapshotProcess(stateHome);
    const paused = await runAction(stateHome, [branch, '--provider', 'vercel', '--pause']);
    check('snapshot pause', paused.exitCode === 0, 'the public CLI retained a snapshot');
    await resumeSnapshot(stateHome, priorProcess, priorIdentity);
  }

  async function resumeSnapshot(stateHome, priorProcess, priorIdentity) {
    const resumed = await attachSession(stateHome);
    try {
      await resumed.waitFor('prior user processes ended', cliTimeoutMs);
      await resumed.waitFor(`session duration: ${timeoutMinutes} minutes`, cliTimeoutMs);
      const displayUrl = publicRoute(resumed.output(), 6080);
      const appUrl = publicRoute(resumed.output(), APP_PORT);
      const displayProbe = await waitForPublicRoute(displayUrl);
      check('snapshot display route healthy', displayProbe.reachable && displayProbe.status >= 200 && displayProbe.status < 400, `status=${displayProbe.status}`);
      const freshIdentity = await readIdentity(resumed, 'snapshot-attach');
      check('snapshot fresh socket', freshIdentity.socket !== priorIdentity.socket, 'snapshot resume received a new session-derived socket');
      check('snapshot fresh tmux session', freshIdentity.session === 'devbox', `session=${freshIdentity.session}`);
      const sentinelPresent = markerFor('snapshot-sentinel-present');
      const sentinelMissing = markerFor('snapshot-sentinel-missing');
      const processPresent = markerFor('snapshot-process-present');
      const processAbsent = markerFor('snapshot-process-absent');
      const sentinelState = await writeAndWaitAny(
        resumed,
        remoteSnapshotStateCommand(sentinelPresent, sentinelMissing, processPresent, processAbsent, priorProcess.sentinelPath, priorProcess.marker, priorProcess.pid),
        [sentinelPresent, sentinelMissing],
      );
      const sentinelRestored = sentinelState.match === sentinelPresent;
      check('snapshot sentinel restored', sentinelRestored, `sentinel=${sentinelState.match}`);
      const processState = await resumed.waitForAny([processPresent, processAbsent], markerTimeoutMs);
      check('snapshot prior process ended', processState.match === processAbsent, `priorPid=${priorProcess.pid}`);
      const workspaceMarker = markerFor('snapshot-workspace');
      const workspace = parseWorkspace(await writeAndWait(resumed, remoteWorkspaceCommand(workspaceMarker), workspaceMarker), workspaceMarker);
      check('snapshot workspace restored', workspace.path.startsWith('/vercel/sandbox/'), `path=${workspace.path}`);
      check('snapshot branch restored', workspace.branch === branch, `branch=${workspace.branch}`);
      const runtimeReady = markerFor('snapshot-runtime-ready');
      const runtimeMissing = markerFor('snapshot-runtime-missing');
      const provider = await readProviderSessionFacts(stateHome);
      check('snapshot socket matches provider session', freshIdentity.socket === sessionSocketPath(provider.sessionId), 'socket is derived from the resumed provider session ID');
      const resumedExpiresAtMs = Date.parse(provider.expiresAt ?? '');
      const priorExpiresAtMs = Date.parse(priorIdentity.providerExpiresAt ?? '');
      check('snapshot fresh deadline', Number.isFinite(resumedExpiresAtMs)
        && Number.isFinite(priorExpiresAtMs)
        && resumedExpiresAtMs > Date.now()
        && resumedExpiresAtMs > priorExpiresAtMs, 'snapshot resume received a new future provider deadline');
      const runtimeState = await writeAndWaitAny(
        resumed,
        remoteRuntimeStateCommand(runtimeReady, runtimeMissing, provider.sessionId),
        [runtimeReady, runtimeMissing],
      );
      check('snapshot runtime state restored', runtimeState.match === runtimeReady, `runtime=${runtimeState.match}`);
      const processBoundaryNotice = resumed.output().includes('prior user processes ended');
      check('snapshot process boundary notice', processBoundaryNotice, 'attach reported the process boundary');
      const snapshotFixtureMarker = markerFor('snapshot-http-fixture');
      const snapshotFixtureIdentity = parseFixtureStartup(
        await writeAndWait(resumed, remoteHttpFixtureCommand(snapshotFixtureMarker), snapshotFixtureMarker),
        snapshotFixtureMarker,
      );
      check('snapshot new HTTP fixture session', snapshotFixtureIdentity.session === 'devbox', `session=${snapshotFixtureIdentity.session}`);
      const snapshotResponse = await waitForFixture(appUrl, snapshotFixtureMarker);
      const appProbe = await waitForPublicRoute(appUrl);
      check('snapshot public route healthy', appProbe.reachable && appProbe.status >= 200 && appProbe.status < 400, `status=${appProbe.status}`);
      check('snapshot public route fixture', snapshotResponse.response === 'devbox-uat-http', 'new fixture returned the expected payload');
      await stopFixture(appUrl, snapshotFixtureMarker);
      resumed.write(Buffer.from([0x1d]));
      const resumedExitCode = await resumed.waitForExit(cliTimeoutMs);
      check('snapshot Ctrl-] detach', resumedExitCode === 0, `exitCode=${resumedExitCode}`);
      check('snapshot fresh provider session', provider.sessionId !== priorIdentity.providerSessionId, `priorFingerprint=${fingerprint(priorIdentity.providerSessionId)}; resumedFingerprint=${fingerprint(provider.sessionId)}`);
      check('snapshot resumed timeout', provider.configuredTimeoutMs === timeoutMinutes * 60 * 1000, `timeout=${provider.configuredTimeoutMs}ms`);
      report.snapshot = {
        notice: processBoundaryNotice,
        socketChanged: freshIdentity.socket !== priorIdentity.socket,
        priorProcessPid: priorProcess.pid,
        priorProcessEnded: processState.match === processAbsent,
        sentinelRestored,
        runtimeServicesRefreshed: runtimeState.match === runtimeReady,
        workspacePath: workspace.path,
        branch: workspace.branch,
        displayRouteStatus: displayProbe.status,
        appRouteStatus: appProbe.status,
        fixturePid: snapshotFixtureIdentity.pid,
        sandboxNameFingerprint: fingerprint(provider.sandboxName),
        sessionIdFingerprint: fingerprint(provider.sessionId),
      };
      return { identity: provider };
    } finally {
      await resumed.close('SIGTERM');
    }
  }

  async function writeAndWait(session, command, marker, retryIntervalMs = 0) {
    const wait = session.waitFor(marker, markerTimeoutMs);
    session.write(command);
    if (retryIntervalMs <= 0) {
      await wait;
      return session.output();
    }
    const retry = setInterval(() => {
      if (!session.output().includes(marker)) session.write(command);
    }, retryIntervalMs);
    try {
      await wait;
      return session.output();
    } finally {
      clearInterval(retry);
    }
  }

  async function writeAndWaitAny(session, command, patterns) {
    const wait = session.waitForAny(patterns, markerTimeoutMs);
    session.write(command);
    return wait;
  }
}
