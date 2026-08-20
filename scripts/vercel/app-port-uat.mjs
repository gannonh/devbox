#!/usr/bin/env node
/**
 * Real-Vercel UAT for zero-configuration public app ports.
 *
 * Drives the production CLI dispatch against a disposable remote fixture: boot,
 * remote scan, the real public-route confirmation prompt, the live port update,
 * an HTTP fetch through the resulting public route, resume, the service port
 * limit boundary, metadata-failure compensation, and removal.
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
import { resolveVercelRepositoryCwd } from '../../dist/providers/vercel/source.js';
import { MAX_VERCEL_SANDBOX_PORTS } from '../../dist/providers/vercel/ports.js';
import { RealShellRunner } from '../../dist/lib/shell.js';

const execFile = promisify(execFileCallback);

const REPO_ROOT = required('DEVBOX_UAT_REPO_ROOT');
const REPO_KEY = process.env.DEVBOX_UAT_REPO_KEY ?? 'github.com/gannonh/uat-devbox';
/** Clone directory name inside the Sandbox; the last path element of the key. */
const REPO_NAME = REPO_KEY.split('/').at(-1);
const VITE_BRANCH = process.env.DEVBOX_UAT_VITE_BRANCH ?? 'uat/vite-zero-config';
const NEXT_BRANCH = process.env.DEVBOX_UAT_NEXT_BRANCH ?? 'uat/next-zero-config';
const VITE_MARKER = 'devbox-uat-vite-zero-config-ok';
const NEXT_MARKER = 'devbox-uat-next-zero-config-ok';
const REPORT_PATH = process.env.DEVBOX_UAT_REPORT ?? join(tmpdir(), 'devbox-app-port-uat.json');
/** `vite`, `next`, or `both` (default). */
const SCENARIOS = process.env.DEVBOX_UAT_ONLY ?? 'both';
/**
 * Scope confirmation is repository-scoped, so exactly the first boot of a run
 * must provoke it and every later boot must not.
 */
let scopeConfirmed = false;
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
    if (SCENARIOS === 'both' || SCENARIOS === 'vite') {
      await viteScenario({ env, stateHome, credentials, realClient });
    } else {
      record('vite-fixture', { skipped: true, reason: `DEVBOX_UAT_ONLY=${SCENARIOS}` });
    }
    if (SCENARIOS === 'both' || SCENARIOS === 'next') {
      await nextScenario({ env, stateHome, credentials, realClient });
    } else {
      record('next-fixture', { skipped: true, reason: `DEVBOX_UAT_ONLY=${SCENARIOS}` });
    }
  } finally {
    await rm(stateHome, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
  return report.failures.length === 0 ? 0 : 1;
}

async function viteScenario({ env, stateHome, credentials, realClient }) {
  const branch = VITE_BRANCH;
  const store = createVercelBranchMetadataStore({ stateHome, repoKey: REPO_KEY, branch });
  const updates = [];
  const client = recordingClient(realClient, updates);
  const registry = providerRegistry(client, stateHome);

  // --- boot: scan, prompt, live port update -------------------------------
  const boot = await runCli(['--provider', 'vercel', branch], {
    env,
    stateHome,
    registry,
    answers: [
      [/Create this Vercel sandbox\?/, 'y\n', !scopeConfirmed],
      [/Expose the detected app port\(s\)\?/, '\n', true],
    ],
  });
  assert(boot.code === 0, `boot exited ${boot.code}`);
  assert(
    scopeConfirmed || /Create this Vercel sandbox\?/.test(boot.stderr),
    'the first boot of the run did not confirm the Vercel scope',
  );
  scopeConfirmed = true;
  assert(/candidate: 5173 \(vite default\)/.test(boot.stderr), 'Vite 5173 candidate was not offered');
  assert(/accepted app routes are PUBLIC/.test(boot.stderr), 'public-route warning was not shown');
  assert(updates.length === 1, `expected exactly one port update, saw ${updates.length}`);
  const update = updates[0];
  assert(update.sandboxIdBefore === update.sandboxIdAfter, 'sandbox identity changed across the update');
  record('vite-boot', {
    branch,
    promptBlock: promptBlock(boot.stderr),
    routesBeforeUpdate: update.before,
    requestedPorts: update.requested,
    routesAfterUpdate: update.after,
    sandboxRecreated: update.sandboxIdBefore !== update.sandboxIdAfter,
    readyBlock: readyBlock(boot.stderr),
  });

  const metadata = await store.read();
  assert(metadata?.appPorts?.selected?.includes(5173), 'selection metadata missing 5173');
  assert(metadata.pendingAppPorts === undefined, 'a pending record survived a successful update');
  record('vite-selection-metadata', {
    selected: metadata.appPorts.selected,
    applied: metadata.appPorts.applied,
    detectorVersion: metadata.appPorts.detectorVersion,
    fingerprintPrefix: metadata.appPorts.fingerprint.slice(0, 12),
    revision: metadata.appPorts.revision,
  });
  report.fixture.viteRevision = metadata.appPorts.revision;

  const name = metadata.identity.name;
  let handle = await realClient.get({ credentials, name, resume: true });
  const workspace = resolveVercelRepositoryCwd(handle.cwd, REPO_NAME);
  const appUrl = routeUrl(handle, 5173);
  assert(appUrl !== undefined, 'no public route for 5173 after the update');

  // --- run the repository's documented dev command ------------------------
  await runInSandbox(realClient, handle, workspace, 'npm', ['install', '--no-audit', '--no-fund'], 300_000);
  await realClient.runCommand(handle, {
    cmd: 'sh',
    args: ['-c', 'npm run dev -- --host 0.0.0.0 --strictPort > /tmp/devbox-uat-dev.log 2>&1'],
    cwd: workspace,
    detached: true,
  });
  const firstFetch = await fetchMarker(appUrl, VITE_MARKER, 180_000);
  assert(firstFetch.markerPresent, `the public 5173 route did not return the fixture marker (status ${firstFetch.status})`);
  record('vite-public-route', {
    port: 5173,
    urlShape: describeUrl(appUrl),
    status: firstFetch.status,
    markerPresent: firstFetch.markerPresent,
    devCommand: 'npm run dev -- --host 0.0.0.0 --strictPort',
    launchedByDevbox: false,
  });

  // --- --url output --------------------------------------------------------
  const urlRun = await runCli(['--provider', 'vercel', branch, '--url'], { env, stateHome, registry });
  assert(urlRun.code === 0, `--url exited ${urlRun.code}`);
  assert(/5173: https:\/\/\S+\s+\(public\)/.test(urlRun.stdout), '--url did not report 5173 as public');
  assert(/6080: https:\/\/\S+\s+\(noVNC display\)/.test(urlRun.stdout), '--url did not identify 6080 as noVNC');
  record('vite-url-output', { lines: urlRun.stdout.trim().split('\n').map(maskRoute) });

  // --- resume --------------------------------------------------------------
  const updatesBeforeAttach = updates.length;
  const attach = await runCli(['--provider', 'vercel', branch, '--attach'], { env, stateHome, registry });
  assert(attach.code === 0, `attach exited ${attach.code}`);
  assert(!/Expose the detected app port/.test(attach.stderr), 'resume re-prompted for an unchanged selection');
  assert(updates.length === updatesBeforeAttach, 'resume issued an unnecessary port update');
  const secondFetch = await fetchMarker(routeUrl(await realClient.get({ credentials, name, resume: true }), 5173), VITE_MARKER, 60_000);
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
  // the installed SDK declaration comments "up to 4 ports", the public docs
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
    },
    recoveryNotice: recoveryText().trim().split('\n'),
    routesAfterRecovery: portsOf(handle),
    committed: committed.appPorts,
  });

  // A port update regenerates route subdomains, so the URL is re-read rather
  // than remembered from before the update.
  const finalFetch = await fetchMarker(routeUrl(handle, 5173), VITE_MARKER, 180_000);
  assert(finalFetch.markerPresent, 'the public 5173 route did not serve after compensation');
  record('vite-route-after-recovery', {
    status: finalFetch.status,
    markerPresent: finalFetch.markerPresent,
  });

  // --- removal -------------------------------------------------------------
  await removeAndVerify({ branch, env, stateHome, registry, realClient, credentials, name, store, label: 'vite' });
}

async function nextScenario({ env, stateHome, credentials, realClient }) {
  const branch = NEXT_BRANCH;
  const store = createVercelBranchMetadataStore({ stateHome, repoKey: REPO_KEY, branch });
  const updates = [];
  const client = recordingClient(realClient, updates);
  const registry = providerRegistry(client, stateHome);

  const boot = await runCli(['--provider', 'vercel', branch], {
    env,
    stateHome,
    registry,
    answers: [
      [/Create this Vercel sandbox\?/, 'y\n', !scopeConfirmed],
      [/Expose the detected app port\(s\)\?/, '\n', true],
    ],
  });
  assert(boot.code === 0, `next boot exited ${boot.code}`);
  assert(
    scopeConfirmed || /Create this Vercel sandbox\?/.test(boot.stderr),
    'the first boot of the run did not confirm the Vercel scope',
  );
  const reconfirmedScope = scopeConfirmed && /Create this Vercel sandbox\?/.test(boot.stderr);
  assert(!reconfirmedScope, 'a second branch in the same repository re-confirmed the Vercel scope');
  scopeConfirmed = true;
  assert(/candidate: 3000 \(next default\)/.test(boot.stderr), 'Next 3000 candidate was not offered');
  assert(updates.length === 1, `expected exactly one port update, saw ${updates.length}`);
  const metadata = await store.read();
  report.fixture.nextRevision = metadata.appPorts.revision;
  const name = metadata.identity.name;
  const handle = await realClient.get({ credentials, name, resume: true });
  const workspace = resolveVercelRepositoryCwd(handle.cwd, REPO_NAME);
  const appUrl = routeUrl(handle, 3000);
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
    args: ['-c', 'npm run dev -- --hostname 0.0.0.0 > /tmp/devbox-uat-dev.log 2>&1'],
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
    devCommand: 'npm run dev -- --hostname 0.0.0.0',
    launchedByDevbox: false,
  });

  await removeAndVerify({ branch, env, stateHome, registry, realClient, credentials, name, store, label: 'next' });
}

async function removeAndVerify({ branch, env, stateHome, registry, realClient, credentials, name, store, label }) {
  const removal = await runCli(['--provider', 'vercel', branch, '--rm'], { env, stateHome, registry });
  assert(removal.code === 0, `remove exited ${removal.code}`);
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
  return {
    local: createLocalProvider(new RealShellRunner()),
    vercel: createVercelProvider({
      client,
      // Scope and branch records must live in the run's disposable state home,
      // not the operator's, so the run proves first-use confirmation and
      // leaves nothing behind.
      stateHome,
      // The only injected seam: the run has no PTY, and the interactive
      // terminal is covered by the existing provider UAT.
      terminal: { attach: async () => ({ status: 'detached', reason: 'escape' }) },
    }),
  };
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
}

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
