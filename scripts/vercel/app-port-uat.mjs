#!/usr/bin/env node
/**
 * Real-Vercel UAT for zero-configuration public app ports.
 *
 * Drives the production CLI dispatch against a disposable remote fixture: boot,
 * remote scan, the real public-route confirmation prompt, the live relay-backed
 * port update, the bounded pre-listen 502, an HTTP fetch through the resulting
 * public route with the project's ordinary dev command, browser HMR, resume,
 * the service port limit boundary, metadata-failure compensation, and removal.
 *
 * Since ADR 0007 a route names a relay listener, not the app's port. Every
 * lookup here goes through the committed mapping for that reason -- asking the
 * Sandbox for a route on 5173 would find nothing, which is the point.
 *
 * The only injected seam is the terminal adapter, so the run does not need a
 * PTY. Everything else -- credentials, source, image, lifecycle, runtime sync,
 * display startup, detector, prompt, port update, metadata -- is production
 * code against real infrastructure.
 *
 * Required environment: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and a
 * GitHub credential reachable by `gh auth token`.
 *
 *   DEVBOX_UAT_REPO_ROOT=<clone of the fixture repo> \
 *   DEVBOX_UAT_REPORT=<path.json> node scripts/vercel/app-port-uat.mjs
 */
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { dispatch } from '../../dist/cli.js';
import { createVercelProvider } from '../../dist/providers/vercel/provider.js';
import { createLocalProvider } from '../../dist/providers/local/provider.js';
import { createVercelSandboxClient } from '../../dist/providers/vercel/client.js';
import { createVercelBranchMetadataStore } from '../../dist/providers/vercel/metadata.js';
import { resolveVercelCredentials } from '../../dist/providers/vercel/auth.js';
import { applyAppPorts } from '../../dist/providers/vercel/app-port-flow.js';
import { cleanupVercelSandbox } from '../../dist/providers/vercel/cleanup.js';
import { listBranchIdentityMatches } from '../../dist/providers/vercel/recovery.js';
import {
  normalizeGitHubSourceRemote,
  resolveVercelRepositoryCwd,
} from '../../dist/providers/vercel/source.js';
import { MAX_VERCEL_SANDBOX_PORTS } from '../../dist/providers/vercel/ports.js';
import { RealShellRunner } from '../../dist/lib/shell.js';
import {
  bootClearingStaleIdentity,
  removeEachMatchingLeftover,
} from './app-port-uat-identity.mjs';

const execFile = promisify(execFileCallback);

const REPO_ROOT = required('DEVBOX_UAT_REPO_ROOT');
/**
 * Metadata is keyed by `remote.canonical` (`github.com/<owner>/<repo>`). The
 * provider always writes under that form; a short `owner/repo` override reads
 * a different file and makes the pin assert fail against a null store.
 */
const REPO_KEY = process.env.DEVBOX_UAT_REPO_KEY ?? 'github.com/gannonh/uat-devbox';
/** Clone directory name inside the Sandbox; the last path element of the key. */
const REPO_NAME = REPO_KEY.split('/').at(-1);
const MONOREPO_BRANCH = process.env.DEVBOX_UAT_MONOREPO_BRANCH ?? 'main';
const MONOREPO_REVISION = '180442037b52775618b2d56cdf7f218514aa9b00';
const MONOREPO_INITIAL_MARKER = 'Project ready!';
const MONOREPO_UPDATED_MARKER = 'devbox-uat-hmr-updated';
const MONOREPO_SNAPSHOT_SENTINEL = 'devbox-uat-snapshot-preserved';
const VITE_BRANCH = process.env.DEVBOX_UAT_VITE_BRANCH ?? 'uat/vite-zero-config';
const NEXT_BRANCH = process.env.DEVBOX_UAT_NEXT_BRANCH ?? 'uat/next-zero-config';
const VITE_MARKER = 'devbox-uat-vite-zero-config-ok';
const NEXT_MARKER = 'devbox-uat-next-zero-config-ok';
const REPORT_PATH = process.env.DEVBOX_UAT_REPORT ?? join(tmpdir(), 'devbox-app-port-uat.json');
/** `monorepo`, `vite`, `next`, or `both`. */
const SCENARIOS = process.env.DEVBOX_UAT_ONLY ?? 'monorepo';
/**
 * Scope confirmation is repository-scoped, so exactly the first boot of a run
 * must provoke it and every later boot must not.
 */
let scopeConfirmed = false;
/** Best-effort failure cleanup for the Sandbox currently under test. */
let cleanupContext;
const NOVNC_PORT = 6080;

const secrets = [];
const report = {
  schemaVersion: 1,
  redacted: true,
  startedAt: new Date().toISOString(),
  fixture: { repository: REPO_KEY },
  phases: [],
  failures: [],
};

main().then(async (code) => {
  report.finishedAt = new Date().toISOString();
  report.failed = code !== 0;
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${redact(JSON.stringify(report, null, 2))}\n`, { mode: 0o600 });
  process.stdout.write(`\nreport: ${REPORT_PATH}\n`);
  process.exit(code);
}, async (error) => {
  report.finishedAt = new Date().toISOString();
  report.failed = true;
  report.failures.push(redact(String(error?.stack ?? error)));
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${redact(JSON.stringify(report, null, 2))}\n`, { mode: 0o600 });
  process.stderr.write(`${redact(String(error?.stack ?? error))}\n`);
  process.exit(1);
});

async function main() {
  for (const key of ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID']) required(key);
  const githubToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? await ghToken();
  addSecret(process.env.VERCEL_TOKEN, githubToken);
  const origin = await assertRepoKeyMatchesOrigin(REPO_ROOT, REPO_KEY);

  const stateHome = await mkdtemp(join(tmpdir(), 'devbox-app-port-uat-state-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'devbox-app-port-uat-home-'));
  const env = {
    PATH: process.env.PATH,
    HOME: fakeHome,
    // Git's system config may pin a GUI credential helper; storing a probe
    // credential in a keychain blocks forever without a desktop session. The
    // provider supplies the token through GIT_ASKPASS, so no helper is needed.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GH_TOKEN: githubToken,
    VERCEL_TOKEN: process.env.VERCEL_TOKEN,
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
  };
  const credentials = await resolveVercelCredentials({ repoRoot: REPO_ROOT, env });
  const realClient = createVercelSandboxClient();

  try {
    if (SCENARIOS === 'monorepo') {
      await monorepoScenario({ env, stateHome, credentials, realClient, origin });
    } else if (SCENARIOS === 'both' || SCENARIOS === 'vite') {
      await viteScenario({ env, stateHome, credentials, realClient, origin });
    } else {
      record('vite-fixture', { skipped: true, reason: `DEVBOX_UAT_ONLY=${SCENARIOS}` });
    }
    if (SCENARIOS === 'both' || SCENARIOS === 'next') {
      await nextScenario({ env, stateHome, credentials, realClient, origin });
    } else {
      record('next-fixture', { skipped: true, reason: `DEVBOX_UAT_ONLY=${SCENARIOS}` });
    }
  } finally {
    if (cleanupContext !== undefined) {
      try {
        await removeAndVerify(cleanupContext);
        cleanupContext = undefined;
      } catch (error) {
        report.failures.push(`failure cleanup: ${redact(String(error?.stack ?? error))}`);
      }
    }
    await rm(stateHome, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
  return report.failures.length === 0 ? 0 : 1;
}

/**
 * The release fixture for this issue is the pinned pnpm monorepo, not the
 * older single-package Vite/Next branches used by the #13 regression run.
 * Keep this scenario explicit so a green report names the exact consumer and
 * the exact ordinary command under test.
 */
async function monorepoScenario({ env, stateHome, credentials, realClient, origin }) {
  const branch = MONOREPO_BRANCH;
  const store = createVercelBranchMetadataStore({ stateHome, repoKey: REPO_KEY, branch });
  const updates = [];
  const client = recordingClient(realClient, updates);
  const registry = providerRegistry(client, stateHome);

  const boot = await bootScenario(branch, {
    env,
    stateHome,
    registry,
    realClient,
    credentials,
    origin,
    answers: ({ attempt }) => [
      [/Create this Vercel sandbox\?/, 'y\n', attempt === 1],
      [/Expose the detected app port\(s\)\?/, '\n', true],
    ],
  });
  assert(boot.code === 0, `monorepo boot exited ${boot.code}`);
  if (boot.retried) record('monorepo-stale-identity-retry', { retried: true });
  if (boot.clearedDuplicates) record('monorepo-duplicate-identity-cleared', { clearedDuplicates: true });
  scopeConfirmed = true;
  const metadata = await rememberCleanup({
    branch,
    env,
    stateHome,
    registry,
    realClient,
    credentials,
    store,
    label: 'monorepo',
  });
  assert(/candidate: 5173 \(vite default — apps\/web\)/.test(boot.stderr), 'monorepo Vite candidate was not offered');
  assert(/accepted app routes are PUBLIC/.test(boot.stderr), 'public-route warning was not shown');
  assert(updates.length === 1, `expected exactly one monorepo port update, saw ${updates.length}`);
  const update = updates[0];
  assert(update.sandboxIdBefore === update.sandboxIdAfter, 'sandbox identity changed across the monorepo update');
  assert(update.before.length === 1 && update.before[0] === NOVNC_PORT, 'monorepo Sandbox was not created with 6080 only');
  assert(!update.requested.includes(5173), 'the raw monorepo app port reached the route set');

  assert(
    metadata?.appPorts !== undefined,
    `monorepo metadata missing under repoKey ${REPO_KEY}; the provider keys stores by remote.canonical`,
  );
  assert(
    metadata.appPorts.revision === MONOREPO_REVISION,
    `UAT did not use the pinned monorepo revision (got ${metadata.appPorts.revision}, expected ${MONOREPO_REVISION})`,
  );
  assert(metadata.pendingAppPorts === undefined, 'a pending record survived the monorepo update');
  const viteRelay = metadata.appPorts.relays.find((entry) => entry.logicalPort === 5173);
  assert(viteRelay !== undefined, 'no monorepo relay mapping was committed for 5173');
  assert(metadata.appPorts.applied.includes(viteRelay.relayPort), 'the monorepo relay port is not applied');
  record('monorepo-boot', {
    branch,
    revision: metadata.appPorts.revision,
    promptBlock: promptBlock(boot.stderr),
    routesBeforeUpdate: update.before,
    requestedPorts: update.requested,
    routesAfterUpdate: update.after,
    sandboxRecreated: update.sandboxIdBefore !== update.sandboxIdAfter,
    readyBlock: readyBlock(boot.stderr),
    staleIdentityRetried: boot.retried === true,
  });
  record('monorepo-selection-metadata', {
    selected: metadata.appPorts.selected,
    relays: metadata.appPorts.relays,
    applied: metadata.appPorts.applied,
    detectorVersion: metadata.appPorts.detectorVersion,
    fingerprintPrefix: metadata.appPorts.fingerprint.slice(0, 12),
    revision: metadata.appPorts.revision,
  });
  report.fixture.pinnedRevision = MONOREPO_REVISION;

  const name = metadata.identity.name;
  let handle = await realClient.get({ credentials, name, resume: true });
  const workspace = resolveVercelRepositoryCwd(handle.cwd, REPO_NAME);
  let appUrl = appRouteUrl(handle, metadata, 5173);
  assert(appUrl !== undefined, 'no public route for the monorepo 5173 mapping');

  const preListen = await probePreListen(appUrl);
  assert(preListen.status === 502, `monorepo pre-listen route returned ${preListen.status}`);
  assert(preListen.elapsedMs < 3_000, `monorepo pre-listen 502 took ${preListen.elapsedMs}ms`);
  assert(preListen.bodyBytes <= 256, `monorepo pre-listen body was ${preListen.bodyBytes} bytes`);
  assert(!preListen.leaksInternals, 'monorepo pre-listen body leaked internal details');
  record('monorepo-pre-listen', preListen);

  await runInSandbox(realClient, handle, workspace, 'pnpm', ['install', '--frozen-lockfile'], 600_000);
  await runInSandbox(realClient, handle, workspace, 'sh', [
    '-c',
    `printf '%s\\n' '${MONOREPO_SNAPSHOT_SENTINEL}' > .devbox-uat-snapshot-sentinel && test -d node_modules`,
  ], 60_000);
  const setupLogBeforeResume = (await runInSandbox(
    realClient,
    handle,
    workspace,
    'sha256sum',
    ['/vercel/.devbox/runtime/setup.log'],
    60_000,
  )).trim();
  await realClient.runCommand(handle, {
    cmd: 'pnpm',
    args: ['--filter', 'web', 'dev'],
    cwd: workspace,
    detached: true,
  });
  const served = await fetchMarker(appUrl, MONOREPO_INITIAL_MARKER, 300_000);
  assert(served.markerPresent, `the public monorepo route did not return the initial marker (status ${served.status})`);
  record('monorepo-public-route', {
    port: 5173,
    relayPort: viteRelay.relayPort,
    urlShape: describeUrl(appUrl),
    status: served.status,
    markerPresent: served.markerPresent,
    devCommand: 'pnpm --filter web dev',
    projectEdits: 'none before HMR phase',
  });

  const urlRun = await runCli(['--provider', 'vercel', branch, '--url'], { env, stateHome, registry });
  assert(urlRun.code === 0, `monorepo --url exited ${urlRun.code}`);
  assert(/5173: https:\/\/\S+\s+\(vite — public\)/.test(urlRun.stdout), 'monorepo --url did not report logical 5173');
  assert(!new RegExp(`^${viteRelay.relayPort}: `, 'm').test(urlRun.stdout), 'monorepo --url printed the relay port');
  assert(/6080: https:\/\/\S+\s+\(noVNC display\)/.test(urlRun.stdout), 'monorepo --url did not identify noVNC');
  record('monorepo-url-output', { lines: urlRun.stdout.trim().split('\n').map(maskRoute) });

  const hmr = await runBrowserHmr(realClient, handle, appUrl, workspace);
  record('monorepo-browser-hmr', hmr.evidence);

  const updatesBeforeAttach = updates.length;
  const attach = await runCli(['--provider', 'vercel', branch, '--attach'], { env, stateHome, registry });
  assert(attach.code === 0, `monorepo attach exited ${attach.code}`);
  assert(!/Expose the detected app port/.test(attach.stderr), 'monorepo attach re-prompted for a healthy selection');
  assert(updates.length === updatesBeforeAttach, 'monorepo attach issued an unnecessary route update');
  const attachedHandle = await realClient.get({ credentials, name, resume: true });
  const attachedUrl = appRouteUrl(attachedHandle, await store.read(), 5173);
  assert(attachedUrl === appUrl, 'same-Sandbox monorepo attach changed the public URL');
  const attachedFetch = await fetchMarker(attachedUrl, MONOREPO_UPDATED_MARKER, 60_000);
  assert(attachedFetch.markerPresent, 'the HMR-updated monorepo route stopped serving after attach');
  record('monorepo-attach-reuse', {
    reprompted: false,
    portUpdates: 0,
    status: attachedFetch.status,
    markerPresent: attachedFetch.markerPresent,
  });

  handle = await realClient.get({ credentials, name, resume: true });
  const boundary = [];
  for (const total of [MAX_VERCEL_SANDBOX_PORTS, MAX_VERCEL_SANDBOX_PORTS + 1, MAX_VERCEL_SANDBOX_PORTS + 2]) {
    handle = await realClient.get({ credentials, name, resume: true });
    const ports = [NOVNC_PORT, ...Array.from({ length: total - 1 }, (_value, index) => 7000 + index)];
    try {
      await realClient.updatePorts(handle, ports);
      boundary.push({ total, accepted: true, routes: portsOf(handle).length });
    } catch (error) {
      boundary.push({ total, accepted: false, status: error?.status, message: redact(String(error?.message ?? error)).slice(0, 200) });
    }
  }
  record('monorepo-port-limit-boundary', { clientMaximum: MAX_VERCEL_SANDBOX_PORTS, attempts: boundary });
  assert(boundary[0].accepted, 'live service rejected the client maximum');
  assert(!boundary[1].accepted && !boundary[2].accepted, 'live service accepted an over-limit route set');

  handle = await realClient.get({ credentials, name, resume: true });
  const failing = {
    ...store,
    write: async (input) => {
      if (input.appPorts !== undefined && input.pendingAppPorts === undefined) throw new Error('injected metadata commit failure');
      return store.write(input);
    },
  };
  let compensationError;
  try {
    await applyAppPorts({
      sandbox: handle,
      client: realClient,
      branchStore: failing,
      repoRoot: REPO_ROOT,
      workspace,
      branch,
      tty: false,
      stdin: new PassThrough(),
      stderr: new PassThrough(),
      exposePorts: [5173],
    });
  } catch (error) {
    compensationError = redact(String(error?.message ?? error));
  }
  const interrupted = await store.read();
  assert(compensationError !== undefined, 'monorepo metadata failure did not surface');
  assert(interrupted?.pendingAppPorts !== undefined, 'monorepo metadata failure left no pending record');

  handle = await realClient.get({ credentials, name, resume: true });
  const recoveryLog = new PassThrough();
  const recoveryText = capture(recoveryLog);
  await applyAppPorts({
    sandbox: handle,
    client: realClient,
    branchStore: store,
    repoRoot: REPO_ROOT,
    workspace,
    branch,
    tty: false,
    stdin: new PassThrough(),
    stderr: recoveryLog,
    exposePorts: [5173],
  });
  const committed = await store.read();
  assert(committed?.pendingAppPorts === undefined, 'monorepo recovery left a pending record');
  assert(committed.appPorts.selected.includes(5173), 'monorepo recovery lost 5173');
  handle = await realClient.get({ credentials, name, resume: true });
  appUrl = appRouteUrl(handle, committed, 5173);
  const recoveredFetch = await fetchMarker(appUrl, MONOREPO_UPDATED_MARKER, 180_000);
  assert(recoveredFetch.markerPresent, 'monorepo route did not serve after compensation');
  record('monorepo-metadata-compensation', {
    injectedFailure: compensationError,
    pendingRecord: {
      previous: interrupted.pendingAppPorts.previous,
      desired: interrupted.pendingAppPorts.desired,
      selected: interrupted.pendingAppPorts.selected,
      sandboxId: interrupted.pendingAppPorts.sandboxId,
    },
    recoveryNotice: recoveryText().trim().split('\n'),
    routesAfterRecovery: portsOf(handle),
    committed: committed.appPorts,
    status: recoveredFetch.status,
  });

  const beforeSelectionChange = appUrl;
  const updatesBeforeSelectionChange = updates.length;
  const changed = await runCli(
    ['--provider', 'vercel', branch, '--attach', '--expose-ports', '5173,4173'],
    { env, stateHome, registry },
  );
  assert(changed.code === 0, `changed-selection attach exited ${changed.code}`);
  assert(updates.length > updatesBeforeSelectionChange, 'changed selection did not update routes');
  handle = await realClient.get({ credentials, name, resume: true });
  const changedMetadata = await store.read();
  const changedUrl = appRouteUrl(handle, changedMetadata, 5173);
  assert(changedUrl !== undefined && changedUrl !== beforeSelectionChange, 'changed selection did not refresh the public URL');
  record('monorepo-changed-selection', {
    selected: changedMetadata.appPorts.selected,
    routes: portsOf(handle),
    urlRefreshed: true,
    urlShape: describeUrl(changedUrl),
  });

  const pause = await runCli(['--provider', 'vercel', branch, '--pause'], { env, stateHome, registry });
  assert(pause.code === 0, `monorepo pause exited ${pause.code}`);
  assert(/paused/i.test(pause.stderr), 'monorepo pause did not report a paused Sandbox');
  const pausedMetadata = await store.read();
  const pausedSnapshotId = pausedMetadata?.pausedSnapshot?.id;
  assert(pausedSnapshotId !== undefined, 'monorepo pause did not retain a snapshot record');
  const pausedList = await runCli(['--provider', 'vercel', '--list'], { env, stateHome, registry });
  assert(pausedList.code === 0, `monorepo paused --list exited ${pausedList.code}`);
  assert(/paused/.test(pausedList.stderr), 'monorepo --list did not report the paused Sandbox');
  record('monorepo-paused-list', {
    paused: true,
    hasSnapshotId: true,
    listReportsPaused: true,
  });
  const resumed = await runCli(['--provider', 'vercel', branch], {
    env,
    stateHome,
    registry,
    answers: [[/Expose the detected app port\(s\)\?/, '\n', false]],
  });
  assert(resumed.code === 0, `monorepo snapshot resume exited ${resumed.code}`);
  const resumedMetadata = await store.read();
  handle = await realClient.get({ credentials, name, resume: true });
  assert(resumedMetadata?.pausedSnapshot === undefined, 'snapshot metadata was not cleared after resume');
  assert(handle.sourceSnapshotId === pausedSnapshotId, 'resumed Sandbox did not identify its source snapshot');
  await runInSandbox(realClient, handle, workspace, 'sh', [
    '-c',
    `test -d node_modules && test -f .devbox-uat-snapshot-sentinel && test "$(cat .devbox-uat-snapshot-sentinel)" = '${MONOREPO_SNAPSHOT_SENTINEL}'`,
  ], 60_000);
  const setupLogAfterResume = (await runInSandbox(
    realClient,
    handle,
    workspace,
    'sha256sum',
    ['/vercel/.devbox/runtime/setup.log'],
    60_000,
  )).trim();
  assert(setupLogAfterResume === setupLogBeforeResume, 'snapshot resume reran the setup script');
  const resumedUrl = appRouteUrl(handle, resumedMetadata, 5173);
  assert(resumedUrl !== undefined, 'snapshot resume did not reconstruct the 5173 mapping');
  assert(!/Expose the detected app port/.test(resumed.stderr), 'snapshot resume re-prompted for recorded app routes');
  await realClient.runCommand(handle, { cmd: 'pnpm', args: ['--filter', 'web', 'dev'], cwd: workspace, detached: true });
  const resumedFetch = await fetchMarker(resumedUrl, MONOREPO_UPDATED_MARKER, 300_000);
  assert(resumedFetch.markerPresent, 'snapshot-resumed monorepo route did not serve the app');
  const runningList = await runCli(['--provider', 'vercel', '--list'], { env, stateHome, registry });
  assert(runningList.code === 0, `monorepo running --list exited ${runningList.code}`);
  assert(/running/.test(runningList.stderr), 'monorepo --list did not report the resumed Sandbox as running');
  record('monorepo-snapshot-resume', {
    routes: portsOf(handle),
    urlShape: describeUrl(resumedUrl),
    status: resumedFetch.status,
    markerPresent: resumedFetch.markerPresent,
    sourceSnapshotProved: true,
    dependenciesPreserved: true,
    setupNotRerun: true,
    routeReprompted: false,
    listReportsRunning: true,
  });

  const idleRegistry = idleProviderRegistry(client, stateHome);
  const idleRun = await runCli(['--provider', 'vercel', branch, '--attach'], {
    env: { ...env, DEVBOX_IDLE_PAUSE_MINUTES: '1' },
    stateHome,
    registry: idleRegistry,
  });
  assert(idleRun.code === 0, `monorepo idle run exited ${idleRun.code}`);
  assert(/auto-paused after the idle window/.test(idleRun.stderr), 'idle controller did not pause the stale-heartbeat box');
  const idleMetadata = await store.read();
  assert(idleMetadata?.pausedSnapshot?.idlePausedAt !== undefined, 'idle pause timestamp was not retained');
  const idleList = await runCli(['--provider', 'vercel', '--list'], { env, stateHome, registry });
  assert(idleList.code === 0 && /paused/.test(idleList.stderr), 'idle-paused box was not listed as paused');
  record('monorepo-idle-pause', {
    paused: true,
    heartbeat: 'stale',
    timestampRecorded: true,
    listReportsPaused: true,
  });

  const resumedAfterIdle = await runCli(['--provider', 'vercel', branch, '--attach'], {
    env,
    stateHome,
    registry,
  });
  assert(resumedAfterIdle.code === 0, `idle snapshot resume exited ${resumedAfterIdle.code}`);
  assert(/idle-paused at \d{4}-\d{2}-\d{2}T/.test(resumedAfterIdle.stderr), 'next attach did not report the idle pause timestamp');
  assert((await store.read())?.pausedSnapshot === undefined, 'idle pause metadata was not cleared after resume');
  record('monorepo-idle-resume', {
    noticeReported: true,
    pausedMetadataCleared: true,
  });

  await removeAndVerify(cleanupContext);
  cleanupContext = undefined;
}

async function viteScenario({ env, stateHome, credentials, realClient, origin }) {
  const branch = VITE_BRANCH;
  const store = createVercelBranchMetadataStore({ stateHome, repoKey: REPO_KEY, branch });
  const updates = [];
  const client = recordingClient(realClient, updates);
  const registry = providerRegistry(client, stateHome);

  // --- boot: scan, prompt, live port update -------------------------------
  const boot = await bootScenario(branch, {
    env,
    stateHome,
    registry,
    realClient,
    credentials,
    origin,
    answers: ({ attempt }) => [
      [/Create this Vercel sandbox\?/, 'y\n', attempt === 1 && !scopeConfirmed],
      [/Expose the detected app port\(s\)\?/, '\n', true],
    ],
  });
  assert(boot.code === 0, `boot exited ${boot.code}`);
  if (boot.retried) record('vite-stale-identity-retry', { retried: true });
  if (boot.clearedDuplicates) record('vite-duplicate-identity-cleared', { clearedDuplicates: true });
  assert(
    scopeConfirmed || /Create this Vercel sandbox\?/.test(boot.stderr),
    'the first boot of the run did not confirm the Vercel scope',
  );
  scopeConfirmed = true;
  const metadata = await rememberCleanup({
    branch,
    env,
    stateHome,
    registry,
    realClient,
    credentials,
    store,
    label: 'vite',
  });
  assert(/candidate: 5173 \(vite default\)/.test(boot.stderr), 'Vite 5173 candidate was not offered');
  assert(/accepted app routes are PUBLIC/.test(boot.stderr), 'public-route warning was not shown');
  assert(updates.length === 1, `expected exactly one port update, saw ${updates.length}`);
  const update = updates[0];
  assert(update.sandboxIdBefore === update.sandboxIdAfter, 'sandbox identity changed across the update');
  // The app's own listener is never public, not even for the window between
  // creation and confirmation.
  assert(
    update.before.length === 1 && update.before[0] === NOVNC_PORT,
    `the Sandbox was created with ${update.before.join(', ')} instead of ${NOVNC_PORT} only`,
  );
  assert(!update.requested.includes(5173), 'the raw app port 5173 reached the route set');
  record('vite-boot', {
    branch,
    promptBlock: promptBlock(boot.stderr),
    routesBeforeUpdate: update.before,
    requestedPorts: update.requested,
    routesAfterUpdate: update.after,
    sandboxRecreated: update.sandboxIdBefore !== update.sandboxIdAfter,
    readyBlock: readyBlock(boot.stderr),
    staleIdentityRetried: boot.retried === true,
  });

  assert(metadata?.appPorts?.selected?.includes(5173), 'selection metadata missing 5173');
  assert(metadata.pendingAppPorts === undefined, 'a pending record survived a successful update');
  const viteRelay = metadata.appPorts.relays.find((entry) => entry.logicalPort === 5173);
  assert(viteRelay !== undefined, 'no relay mapping was committed for 5173');
  assert(metadata.appPorts.applied.includes(viteRelay.relayPort), 'the committed relay port is not applied');
  record('vite-selection-metadata', {
    selected: metadata.appPorts.selected,
    relays: metadata.appPorts.relays,
    applied: metadata.appPorts.applied,
    detectorVersion: metadata.appPorts.detectorVersion,
    fingerprintPrefix: metadata.appPorts.fingerprint.slice(0, 12),
    revision: metadata.appPorts.revision,
  });
  report.fixture.viteRevision = metadata.appPorts.revision;

  const name = metadata.identity.name;
  let handle = await realClient.get({ credentials, name, resume: true });
  const workspace = resolveVercelRepositoryCwd(handle.cwd, REPO_NAME);
  const appUrl = appRouteUrl(handle, metadata, 5173);
  assert(appUrl !== undefined, 'no public route for 5173 after the update');

  // --- the route answers before the app exists -----------------------------
  const preListen = await probePreListen(appUrl);
  assert(preListen.status === 502, `pre-listen route returned ${preListen.status}, expected 502`);
  assert(preListen.elapsedMs < 3_000, `pre-listen 502 took ${preListen.elapsedMs}ms`);
  assert(preListen.bodyBytes <= 256, `pre-listen body was ${preListen.bodyBytes} bytes`);
  assert(!preListen.leaksInternals, 'the pre-listen body leaked an internal path or stack trace');
  record('vite-pre-listen', preListen);

  // --- run the repository's ordinary dev command --------------------------
  // No --host, no --strictPort, no project edit: that is the acceptance.
  await runInSandbox(realClient, handle, workspace, 'npm', ['install', '--no-audit', '--no-fund'], 300_000);
  await realClient.runCommand(handle, {
    cmd: 'sh',
    args: ['-c', 'npm run dev > /tmp/devbox-uat-dev.log 2>&1'],
    cwd: workspace,
    detached: true,
  });
  // The same URL, with no second route update between the 502 and the app.
  const updatesBeforeServe = updates.length;
  const firstFetch = await fetchMarker(appUrl, VITE_MARKER, 180_000);
  assert(firstFetch.markerPresent, `the public 5173 route did not return the fixture marker (status ${firstFetch.status})`);
  assert(updates.length === updatesBeforeServe, 'the app became reachable only after another route update');
  record('vite-public-route', {
    port: 5173,
    relayPort: viteRelay.relayPort,
    urlShape: describeUrl(appUrl),
    status: firstFetch.status,
    markerPresent: firstFetch.markerPresent,
    devCommand: 'npm run dev',
    projectEdits: 'none',
    launchedByDevbox: false,
  });

  // --- --url output --------------------------------------------------------
  const urlRun = await runCli(['--provider', 'vercel', branch, '--url'], { env, stateHome, registry });
  assert(urlRun.code === 0, `--url exited ${urlRun.code}`);
  // The logical port is what is printed; the relay port never appears.
  assert(/5173: https:\/\/\S+\s+\(vite — public\)/.test(urlRun.stdout), '--url did not report 5173 as a public vite route');
  assert(
    !new RegExp(`^${viteRelay.relayPort}: `, 'm').test(urlRun.stdout),
    '--url printed the relay listener port as if it were an app port',
  );
  assert(/6080: https:\/\/\S+\s+\(noVNC display\)/.test(urlRun.stdout), '--url did not identify 6080 as noVNC');
  record('vite-url-output', { lines: urlRun.stdout.trim().split('\n').map(maskRoute) });

  // --- resume --------------------------------------------------------------
  const updatesBeforeAttach = updates.length;
  const attach = await runCli(['--provider', 'vercel', branch, '--attach'], { env, stateHome, registry });
  assert(attach.code === 0, `attach exited ${attach.code}`);
  assert(!/Expose the detected app port/.test(attach.stderr), 'resume re-prompted for an unchanged selection');
  assert(updates.length === updatesBeforeAttach, 'resume issued an unnecessary port update');
  const resumedHandle = await realClient.get({ credentials, name, resume: true });
  const resumedUrl = appRouteUrl(resumedHandle, await store.read(), 5173);
  assert(resumedUrl === appUrl, 'a same-sandbox attach changed the public URL');
  const secondFetch = await fetchMarker(resumedUrl, VITE_MARKER, 60_000);
  assert(secondFetch.markerPresent, 'the public 5173 route stopped serving after resume');
  record('vite-resume', {
    reprompted: false,
    portUpdates: 0,
    status: secondFetch.status,
    markerPresent: secondFetch.markerPresent,
    resumedBlock: readyBlock(attach.stderr),
  });

  // --- live service port limit boundary ------------------------------------
  // The three available sources disagree about the maximum, so measure it:
  // the installed SDK declaration comments "up to 15 ports", the public docs
  // say 15, and the request schema refuses a 16th. Only the service knows.
  const boundary = [];
  for (const total of [MAX_VERCEL_SANDBOX_PORTS, MAX_VERCEL_SANDBOX_PORTS + 1, MAX_VERCEL_SANDBOX_PORTS + 2]) {
    handle = await realClient.get({ credentials, name, resume: true });
    const ports = [NOVNC_PORT, ...Array.from({ length: total - 1 }, (_value, index) => 7000 + index)];
    try {
      await realClient.updatePorts(handle, ports);
      boundary.push({ total, accepted: true, routes: portsOf(handle).length });
    } catch (error) {
      boundary.push({
        total,
        accepted: false,
        status: error?.status,
        message: redact(String(error?.message ?? error)).slice(0, 200),
      });
    }
  }
  record('port-limit-boundary', {
    clientMaximum: MAX_VERCEL_SANDBOX_PORTS,
    attempts: boundary,
  });
  assert(boundary[0].accepted, `live service rejected the client maximum of ${MAX_VERCEL_SANDBOX_PORTS} ports`);
  assert(!boundary[1].accepted, `live service accepted ${MAX_VERCEL_SANDBOX_PORTS + 1} ports`);
  assert(!boundary[2].accepted, `live service accepted ${MAX_VERCEL_SANDBOX_PORTS + 2} ports`);

  // --- metadata-failure compensation --------------------------------------
  handle = await realClient.get({ credentials, name, resume: true });
  const failing = {
    ...store,
    write: async (input) => {
      if (input.appPorts !== undefined && input.pendingAppPorts === undefined) {
        throw new Error('injected metadata commit failure');
      }
      return store.write(input);
    },
  };
  let compensationError;
  try {
    await applyAppPorts({
      sandbox: handle,
      client: realClient,
      branchStore: failing,
      repoRoot: REPO_ROOT,
      workspace,
      branch,
      tty: false,
      stdin: new PassThrough(),
      stderr: new PassThrough(),
      exposePorts: [5173],
    });
  } catch (error) {
    compensationError = redact(String(error?.message ?? error));
  }
  const interrupted = await store.read();
  assert(compensationError !== undefined, 'injected metadata failure did not surface');
  assert(interrupted?.pendingAppPorts !== undefined, 'interrupted update left no pending record');

  handle = await realClient.get({ credentials, name, resume: true });
  const recoveryLog = new PassThrough();
  const recoveryText = capture(recoveryLog);
  await applyAppPorts({
    sandbox: handle,
    client: realClient,
    branchStore: store,
    repoRoot: REPO_ROOT,
    workspace,
    branch,
    tty: false,
    stdin: new PassThrough(),
    stderr: recoveryLog,
    exposePorts: [5173],
  });
  const committed = await store.read();
  assert(committed?.pendingAppPorts === undefined, 'recovery left the pending record in place');
  assert(committed.appPorts.selected.includes(5173), 'recovery lost the selected app port');
  handle = await realClient.get({ credentials, name, resume: true });
  record('metadata-compensation', {
    injectedFailure: compensationError,
    pendingRecord: {
      previous: interrupted.pendingAppPorts.previous,
      desired: interrupted.pendingAppPorts.desired,
      selected: interrupted.pendingAppPorts.selected,
      sandboxId: interrupted.pendingAppPorts.sandboxId,
    },
    recoveryNotice: recoveryText().trim().split('\n'),
    routesAfterRecovery: portsOf(handle),
    committed: committed.appPorts,
  });

  // A port update regenerates route subdomains, so the URL is re-read rather
  // than remembered from before the update.
  const finalFetch = await fetchMarker(appRouteUrl(handle, committed, 5173), VITE_MARKER, 180_000);
  assert(finalFetch.markerPresent, 'the public 5173 route did not serve after compensation');
  record('vite-route-after-recovery', {
    status: finalFetch.status,
    markerPresent: finalFetch.markerPresent,
  });

  // --- removal -------------------------------------------------------------
  await removeAndVerify(cleanupContext);
  cleanupContext = undefined;
}

async function nextScenario({ env, stateHome, credentials, realClient, origin }) {
  const branch = NEXT_BRANCH;
  const store = createVercelBranchMetadataStore({ stateHome, repoKey: REPO_KEY, branch });
  const updates = [];
  const client = recordingClient(realClient, updates);
  const registry = providerRegistry(client, stateHome);

  const boot = await bootScenario(branch, {
    env,
    stateHome,
    registry,
    realClient,
    credentials,
    origin,
    answers: ({ attempt }) => [
      [/Create this Vercel sandbox\?/, 'y\n', attempt === 1 && !scopeConfirmed],
      [/Expose the detected app port\(s\)\?/, '\n', true],
    ],
  });
  assert(boot.code === 0, `next boot exited ${boot.code}`);
  if (boot.retried) record('next-stale-identity-retry', { retried: true });
  if (boot.clearedDuplicates) record('next-duplicate-identity-cleared', { clearedDuplicates: true });
  assert(
    scopeConfirmed || /Create this Vercel sandbox\?/.test(boot.stderr),
    'the first boot of the run did not confirm the Vercel scope',
  );
  const reconfirmedScope = scopeConfirmed && /Create this Vercel sandbox\?/.test(boot.stderr);
  assert(!reconfirmedScope, 'a second branch in the same repository re-confirmed the Vercel scope');
  scopeConfirmed = true;
  const metadata = await rememberCleanup({
    branch,
    env,
    stateHome,
    registry,
    realClient,
    credentials,
    store,
    label: 'next',
  });
  assert(/candidate: 3000 \(next default\)/.test(boot.stderr), 'Next 3000 candidate was not offered');
  assert(updates.length === 1, `expected exactly one port update, saw ${updates.length}`);
  report.fixture.nextRevision = metadata.appPorts.revision;
  const name = metadata.identity.name;
  const handle = await realClient.get({ credentials, name, resume: true });
  const workspace = resolveVercelRepositoryCwd(handle.cwd, REPO_NAME);
  const appUrl = appRouteUrl(handle, metadata, 3000);
  assert(appUrl !== undefined, 'no public route for 3000 after the update');
  assert(
    updates[0].before.length === 1 && updates[0].before[0] === NOVNC_PORT,
    `the Sandbox was created with ${updates[0].before.join(', ')} instead of ${NOVNC_PORT} only`,
  );
  record('next-boot', {
    branch,
    promptBlock: promptBlock(boot.stderr),
    routesBeforeUpdate: updates[0].before,
    routesAfterUpdate: updates[0].after,
    sandboxRecreated: updates[0].sandboxIdBefore !== updates[0].sandboxIdAfter,
    selected: metadata.appPorts.selected,
    revision: metadata.appPorts.revision,
  });

  await runInSandbox(realClient, handle, workspace, 'npm', ['install', '--no-audit', '--no-fund'], 420_000);
  await realClient.runCommand(handle, {
    cmd: 'sh',
    args: ['-c', 'npm run dev > /tmp/devbox-uat-dev.log 2>&1'],
    cwd: workspace,
    detached: true,
  });
  const fetched = await fetchMarker(appUrl, NEXT_MARKER, 300_000);
  assert(fetched.markerPresent, `the public 3000 route did not return the fixture marker (status ${fetched.status})`);
  record('next-public-route', {
    port: 3000,
    urlShape: describeUrl(appUrl),
    status: fetched.status,
    markerPresent: fetched.markerPresent,
    devCommand: 'npm run dev',
    projectEdits: 'none',
    launchedByDevbox: false,
  });

  await removeAndVerify(cleanupContext);
  cleanupContext = undefined;
}

/**
 * Preflight `--rm` the stable fixture identity, then boot. A leftover from a
 * previous gate (Release #33 booted, then failed the pin assert before cleanup
 * was registered) is an identity conflict, not a confirmation hang. The UAT
 * answers the create prompt; this path is what actually unblocks CI.
 *
 * `--rm` still aborts when more than one live sandbox shares that identity
 * (Release #35). The UAT then deletes each match by exact name, the same way
 * private-repo smoke preflight does, and never touches a foreign-scope box.
 *
 * Human `devbox --provider vercel <branch>` and `--rm` still fail closed.
 */
async function bootScenario(branch, { env, stateHome, registry, answers, realClient, credentials, origin }) {
  return bootClearingStaleIdentity({
    remove: () => runCli(['--provider', 'vercel', branch, '--rm'], { env, stateHome, registry }),
    removeMatching: () => removeMatchingFixtureSandboxes({
      client: realClient,
      credentials,
      origin,
      branch,
    }),
    boot: ({ attempt }) => runCli(['--provider', 'vercel', branch], {
      env,
      stateHome,
      registry,
      answers: answers({ attempt }),
    }),
  });
}

/**
 * Clear every live sandbox whose identity tag matches this fixture branch and
 * Vercel team/project. Names come from the listing, so leftovers from another
 * package version (same repo+branch+scope, different name prefix) are included.
 * Foreign-scope records stay untouched.
 */
async function removeMatchingFixtureSandboxes({ client, credentials, origin, branch }) {
  const summary = await removeEachMatchingLeftover({
    inspect: () => listBranchIdentityMatches(client, origin, branch, credentials),
    cleanup: (record) => cleanupVercelSandbox({
      name: record.name,
      credentials,
      expectedTags: record.tags,
      knownSnapshotIds: typeof record.currentSnapshotId === 'string' && record.currentSnapshotId.trim()
        ? [record.currentSnapshotId]
        : [],
      adapter: cleanupAdapter(client),
    }),
  });
  process.stderr.write(
    `[uat] cleared ${summary.removed.length} leftover sandbox(es) for the fixture identity`
    + (summary.foreignScope.length > 0
      ? ` (${summary.foreignScope.length} foreign-scope left untouched)`
      : '')
    + '\n',
  );
  record('leftover-identity-duplicates', {
    removed: summary.removed.length,
    foreignScopeUntouched: summary.foreignScope.length,
  });
  return summary;
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

/**
 * Register failure cleanup as soon as boot has a live box, before later
 * asserts. Release #33 left the leftover because cleanupContext was assigned
 * after the pin check.
 */
async function rememberCleanup(context) {
  const metadata = await context.store.read().catch(() => null);
  cleanupContext = {
    ...context,
    name: metadata?.identity?.name,
  };
  return metadata;
}

async function removeAndVerify({ branch, env, stateHome, registry, realClient, credentials, name, store, label }) {
  const removal = await runCli(['--provider', 'vercel', branch, '--rm'], { env, stateHome, registry });
  assert(removal.code === 0, `remove exited ${removal.code}`);

  if (!name) {
    assert(
      /cleanup verified/.test(removal.stderr) || /nothing to remove/.test(removal.stderr),
      'remove did not report verified cleanup',
    );
    record(`${label}-cleanup`, {
      identityNameMissing: true,
      cleanupVerified: /cleanup verified/.test(removal.stderr),
    });
    const metadata = await store.read().catch(() => null);
    assert(metadata === null, 'local selected-port metadata survived removal');
    return;
  }

  assert(/cleanup verified/.test(removal.stderr), 'remove did not report verified cleanup');
  const remaining = await realClient.listSandboxes({ credentials, namePrefix: name });
  const snapshots = await realClient.listSnapshots({ credentials, name }).catch(() => []);
  const liveSnapshots = snapshots.filter((snapshot) => snapshot.status !== 'deleted');
  const metadata = await store.read().catch(() => null);
  record(`${label}-cleanup`, {
    sandboxesRemaining: remaining.filter((entry) => entry.name === name).length,
    nonDeletedSnapshots: liveSnapshots.length,
    localMetadataPresent: metadata !== null,
  });
  assert(remaining.every((entry) => entry.name !== name), 'a sandbox with the run name survived removal');
  assert(liveSnapshots.length === 0, 'a non-deleted snapshot survived removal');
  assert(metadata === null, 'local selected-port metadata survived removal');
}

// --- harness ---------------------------------------------------------------

function providerRegistry(client, stateHome) {
  return providerRegistryWithTerminal(client, stateHome, {
    // The only injected seam: the run has no PTY, and the interactive
    // terminal is covered by the existing provider UAT.
    attach: async () => ({ status: 'detached', reason: 'escape' }),
  });
}

function providerRegistryWithTerminal(client, stateHome, terminal) {
  return {
    local: createLocalProvider(new RealShellRunner()),
    vercel: createVercelProvider({
      client,
      // Scope and branch records must live in the run's disposable state home,
      // not the operator's, so the run proves first-use confirmation and
      // leaves nothing behind.
      stateHome,
      terminal,
    }),
  };
}

function idleProviderRegistry(client, stateHome) {
  return providerRegistryWithTerminal(client, stateHome, {
    attach: async (sandbox) => {
      await client.runCommand(sandbox, {
        cmd: 'sh',
        args: [
          '-c',
          'umask 077; mkdir -p /vercel/.devbox/runtime; printf "1\\n" > /vercel/.devbox/runtime/heartbeat; chmod 600 /vercel/.devbox/runtime/heartbeat; touch -d @1 /vercel/.devbox/runtime/heartbeat',
        ],
      });
      // One full one-minute policy window plus a margin lets the production
      // idle monitor issue the real stop-and-snapshot operation.
      await new Promise((resolve) => setTimeout(resolve, 70_000));
      return { status: 'detached', reason: 'escape' };
    },
  });
}

function recordingClient(client, updates) {
  return {
    ...client,
    updatePorts: async (sandbox, ports, options) => {
      const entry = {
        before: portsOf(sandbox),
        requested: [...ports],
        sandboxIdBefore: sandbox.id,
      };
      await client.updatePorts(sandbox, ports, options);
      entry.after = portsOf(sandbox);
      entry.sandboxIdAfter = sandbox.id;
      updates.push(entry);
      return undefined;
    },
  };
}

async function runCli(args, { env, stateHome, registry, answers = [] }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const readStdout = capture(stdout);
  const pending = answers.map(([pattern, answer, required = false]) => ({
    pattern,
    answer,
    required,
    satisfied: false,
  }));
  let stderrText = '';
  stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrText += text;
    // Echo live: a boot spends minutes in image resolution, source checkout,
    // and display startup, and a silent run is indistinguishable from a hang.
    process.stderr.write(redact(text));
    for (const item of pending) {
      if (!item.satisfied && item.pattern.test(stderrText)) {
        item.satisfied = true;
        stdin.write(item.answer);
      }
    }
  });
  process.stderr.write(`\n[uat] devbox ${args.join(' ')}\n`);
  const code = await dispatch(args, { stdin, stdout, stderr }, {
    providerRegistry: registry,
    repoRoot: REPO_ROOT,
    stateHome,
    env,
    tty: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Scope confirmation is repository-scoped, so only the first boot in a run
  // sees it; a required expectation is one this scenario must provoke.
  const missing = pending.filter((item) => item.required && !item.satisfied);
  if (missing.length > 0 && code === 0) {
    throw new Error(`expected prompt did not appear: ${missing[0].pattern}`);
  }
  return { code, stdout: readStdout(), stderr: stderrText };
}

function capture(stream) {
  let text = '';
  stream.on('data', (chunk) => { text += chunk.toString('utf8'); });
  return () => text;
}

async function runInSandbox(client, sandbox, cwd, cmd, args, timeoutMs) {
  const result = await client.runCommand(sandbox, {
    cmd,
    args,
    cwd,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (result.exitCode !== 0) {
    const stderrText = result.stderr ? await result.stderr() : '';
    throw new Error(`${cmd} failed with exit code ${result.exitCode}: ${redact(stderrText).slice(0, 400)}`);
  }
  return result.stdout ? await result.stdout() : '';
}

/**
 * Exercise the public route with a real Chromium page. The browser and CDP
 * client live in the Sandbox so the Vite HMR WebSocket crosses the same relay
 * as an end user. Screenshots are copied to the host evidence directory, but
 * the HTML and URL values in the report stay redaction-safe.
 */
async function runBrowserHmr(client, sandbox, appUrl, workspace) {
  const harnessPath = '/tmp/devbox-app-port-hmr.mjs';
  await client.writeFiles(sandbox, [{ path: harnessPath, content: Buffer.from(browserHmrHarness) }]);
  const result = await client.runCommand(sandbox, {
    cmd: 'node',
    args: [harnessPath, appUrl, workspace],
    cwd: workspace,
    signal: AbortSignal.timeout(180_000),
  });
  const [stdout, stderr] = await Promise.all([
    result.stdout ? result.stdout() : Promise.resolve(''),
    result.stderr ? result.stderr() : Promise.resolve(''),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`browser HMR harness failed with exit code ${result.exitCode}: ${redact(stderr).slice(0, 500)}`);
  }

  let payload;
  try {
    payload = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch (error) {
    throw new Error(`browser HMR harness returned invalid evidence: ${redact(String(error?.message ?? error))}`);
  }
  assert(payload.ok === true, 'browser HMR harness did not report success');
  const screenshotNames = [
    ['beforeScreenshot', 'app-port-uat-hmr-before.png'],
    ['afterScreenshot', 'app-port-uat-hmr-after.png'],
  ];
  const evidence = { ...payload };
  delete evidence.ok;
  for (const [field, filename] of screenshotNames) {
    assert(typeof payload[field] === 'string' && payload[field].length > 0, `browser HMR harness omitted ${field}`);
    const artifactPath = join(dirname(REPORT_PATH), filename);
    await writeFile(artifactPath, Buffer.from(payload[field], 'base64'), { mode: 0o600 });
    evidence[field] = filename;
  }
  return { evidence };
}

const browserHmrHarness = String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const appUrl = process.argv[2];
const workspace = process.argv[3];
const initialMarker = 'Project ready!';
const updatedMarker = 'devbox-uat-hmr-updated';
const deadlineMs = 120_000;
let browser;
let socket;
let navigationEvents = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTarget() {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/list');
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error('Chromium CDP target did not open: ' + (lastError?.message ?? 'timeout'));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const candidate = new WebSocket(url);
    let settled = false;
    candidate.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      resolve(candidate);
    }, { once: true });
    candidate.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      reject(new Error('Chromium CDP WebSocket failed to open'));
    }, { once: true });
  });
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.once('error', (error) => finish({ error: error.message }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

async function attemptVideo() {
  const outputPath = '/tmp/devbox-app-port-hmr.webm';
  const result = await runProcess('ffmpeg', ['-version'], 3_000);
  if (result.error) {
    return { attempted: true, available: false, captured: false, reason: 'ffmpeg unavailable' };
  }
  const capture = await runProcess('ffmpeg', [
    '-y', '-f', 'x11grab', '-video_size', '1280x720', '-framerate', '5',
    '-i', process.env.DISPLAY || ':99', '-t', '2', outputPath,
  ], 5_000);
  return {
    attempted: true,
    available: true,
    captured: capture.code === 0,
    reason: capture.code === 0 ? 'captured in Sandbox' : 'display capture unavailable',
  };
}

const pending = new Map();
let nextId = 1;

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP ' + method + ' timed out'));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error('browser evaluation failed');
  return response.result?.result?.value;
}

async function waitFor(check, message) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(message);
}

try {
  assert(appUrl && workspace, 'browser HMR harness requires an app URL and workspace');
  browser = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--ignore-certificate-errors', '--remote-allow-origins=*',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/devbox-app-port-chromium', appUrl,
  ], { stdio: 'ignore' });
  const target = await waitForTarget();
  socket = await connect(target.webSocketDebuggerUrl);
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method === 'Page.frameNavigated') navigationEvents += 1;
    if (message.id === undefined) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error('CDP error for ' + message.id));
    else item.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Chromium CDP WebSocket closed'));
    }
    pending.clear();
  }, { once: true });

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const initialText = await waitFor(
    async () => {
      const value = await evaluate('document.body.innerText');
      return typeof value === 'string' && value.includes(initialMarker) ? value : null;
    },
    'browser did not render the initial marker',
  );
  const initialHref = await evaluate('location.href');
  const navigationEntryCount = await evaluate("performance.getEntriesByType('navigation').length");
  await evaluate("window.__devboxHmrSentinel = 'devbox-uat-hmr-sentinel'; void 0");
  const beforeScreenshot = (await cdp('Page.captureScreenshot', { format: 'png' })).data;
  navigationEvents = 0;

  const sourcePath = join(workspace, 'apps/web/src/App.tsx');
  const source = await readFile(sourcePath, 'utf8');
  const updatedSource = source.replace(initialMarker, updatedMarker);
  assert(updatedSource !== source, 'fixture App.tsx did not contain the initial marker');
  await writeFile(sourcePath, updatedSource);

  const updatedText = await waitFor(
    async () => {
      const value = await evaluate('document.body.innerText');
      return typeof value === 'string' && value.includes(updatedMarker) ? value : null;
    },
    'browser did not observe the HMR marker',
  );
  const sentinel = await evaluate('window.__devboxHmrSentinel');
  const updatedHref = await evaluate('location.href');
  const updatedNavigationEntryCount = await evaluate("performance.getEntriesByType('navigation').length");
  assert(sentinel === 'devbox-uat-hmr-sentinel', 'HMR lost the browser state sentinel');
  assert(updatedHref === initialHref, 'HMR changed the public browser URL');
  assert(navigationEvents === 0, 'HMR triggered ' + navigationEvents + ' page navigations');
  assert(updatedNavigationEntryCount === navigationEntryCount, 'HMR created a new navigation entry');
  const afterScreenshot = (await cdp('Page.captureScreenshot', { format: 'png' })).data;
  const videoAttempt = await attemptVideo();

  process.stdout.write(JSON.stringify({
    ok: true,
    initialMarkerPresent: initialText.includes(initialMarker),
    updatedMarkerPresent: updatedText.includes(updatedMarker),
    sentinelPreserved: sentinel === 'devbox-uat-hmr-sentinel',
    navigationCount: navigationEvents,
    navigationEntryCount: updatedNavigationEntryCount,
    urlPreserved: updatedHref === initialHref,
    beforeScreenshot,
    afterScreenshot,
    videoAttempt,
  }) + '\n');
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  process.exitCode = 1;
} finally {
  if (socket) socket.close();
  if (browser && !browser.killed) browser.kill('SIGTERM');
}
`;

async function fetchMarker(url, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      lastStatus = response.status;
      const body = await response.text();
      if (response.ok && body.includes(marker)) {
        return { status: response.status, markerPresent: true };
      }
    } catch {
      // The dev server has not started listening yet.
    }
    if (Date.now() > deadline) {
      return { status: lastStatus ?? 0, markerPresent: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function portsOf(sandbox) {
  return [...(sandbox.routes ?? [])].map((route) => route.port).sort((left, right) => left - right);
}

function routeUrl(sandbox, port) {
  return (sandbox.routes ?? []).find((route) => route.port === port)?.url;
}

/** The public URL for a logical app port, joined through its relay mapping. */
function appRouteUrl(sandbox, metadata, logicalPort) {
  const mapping = (metadata?.appPorts?.relays ?? [])
    .find((entry) => entry.logicalPort === logicalPort);
  return mapping === undefined ? undefined : routeUrl(sandbox, mapping.relayPort);
}

/**
 * The relay answers before the app does: a bounded generic 502, once.
 *
 * Checked before the dev server starts, because after it starts the same URL
 * has to serve the app with no second route update.
 */
async function probePreListen(url) {
  const started = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  return {
    status: response.status,
    elapsedMs: Date.now() - started,
    bodyBytes: Buffer.byteLength(body),
    leaksInternals: /\/vercel|\/usr|at .*app-relay|Error:/.test(body),
  };
}

/** Route hosts are per-sandbox, so evidence keeps their shape, not their value. */
function describeUrl(url) {
  if (!url) return null;
  const parsed = new URL(url);
  return {
    protocol: parsed.protocol,
    hasCredentials: Boolean(parsed.username || parsed.password),
    hasQueryOrFragment: Boolean(parsed.search || parsed.hash),
    hostSuffix: parsed.hostname.split('.').slice(-2).join('.'),
  };
}

function maskRoute(line) {
  return line.replace(/https:\/\/[^\s]+/g, (url) => {
    const parsed = new URL(url);
    return `https://<sandbox>.${parsed.hostname.split('.').slice(-2).join('.')}${parsed.pathname}${parsed.search ? '?<redacted>' : ''}`;
  });
}

function promptBlock(text) {
  const start = text.indexOf('Detected app ports in the remote checkout:');
  if (start < 0) return null;
  return text.slice(start).split('\n').slice(0, 5).map((line) => line.trimEnd());
}

function readyBlock(text) {
  const start = Math.max(text.lastIndexOf('Vercel devbox ready'), text.lastIndexOf('Vercel devbox resumed'));
  if (start < 0) return null;
  return text.slice(start).split('\n').slice(0, 8).map(maskRoute).map((line) => redact(line).trimEnd());
}

function record(phase, detail) {
  report.phases.push({ phase, ...detail });
  process.stderr.write(`[uat] ${phase}: ok\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function addSecret(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 8) secrets.push(value);
  }
}

function redact(text) {
  let output = String(text);
  for (const secret of secrets) {
    output = output.split(secret).join('[REDACTED]');
    output = output.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  // The display access code is generated per branch; never keep it in evidence.
  // Both patterns match only code characters: redaction also runs over
  // serialized JSON, and a greedy class would eat the closing quote.
  output = output.replace(/(access code: )[A-Za-z0-9_-]+/g, '$1[REDACTED]');
  output = output.replace(/([?&]token=)[A-Za-z0-9_.~%-]+/g, '$1[REDACTED]');
  return output;
}

async function ghToken() {
  const { stdout } = await execFile('gh', ['auth', 'token'], { timeout: 15_000 });
  return stdout.trim();
}

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/**
 * The provider persists branch metadata under `remote.canonical`. The UAT must
 * read the same key or every post-boot assert against the store is a false
 * negative (null metadata), including the pinned-revision gate.
 */
async function assertRepoKeyMatchesOrigin(repoRoot, repoKey) {
  const { stdout } = await execFile('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    timeout: 15_000,
  });
  const origin = normalizeGitHubSourceRemote(stdout.trim());
  assert(
    repoKey === origin.canonical,
    `DEVBOX_UAT_REPO_KEY (${repoKey}) must equal the fixture origin canonical key (${origin.canonical})`,
  );
  return origin;
}
