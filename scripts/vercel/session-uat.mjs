#!/usr/bin/env node
/**
 * Public CLI PTY UAT for Vercel VM-session lifetime and terminal reconnects.
 *
 * The driver runs `node dist/cli.js` through util-linux `script`, which gives
 * the CLI a real PTY without adding a native dependency to the package.
 * The reconnect command is `node dist/cli.js "$BRANCH" --provider vercel
 * --expose-ports 4173`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const APP_PORT = 4173;
const MODE = process.argv[2] === '--cleanup'
  ? 'cleanup'
  : process.env.DEVBOX_UAT_MODE ?? 'reconnect';
const REPO_ROOT = required('DEVBOX_UAT_REPO_ROOT');
const BRANCH = required('DEVBOX_UAT_BRANCH');
const CLI_PATH = resolve(process.env.DEVBOX_CLI ?? 'dist/cli.js');
const REPORT_PATH = process.env.DEVBOX_UAT_REPORT ?? resolve('uat-evidence/session-uat.json');
const STATE_HOME = process.env.DEVBOX_UAT_STATE_HOME;
const TIMEOUT_MINUTES = positiveInteger('DEVBOX_UAT_TIMEOUT_MINUTES', MODE === 'duration' ? 120 : 60);
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

  const preflight = await runCleanup(stateHome);
  report.preflight = { attempted: true, ...preflight };
  if (!preflight.accepted) throw new Error(`preflight cleanup failed with exit code ${preflight.exitCode}`);

  let active;
  try {
    active = await startSession(stateHome);
    await verifyInitialSession(active);
    if (MODE === 'duration') {
      await verifyDurationSession(active);
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
    '--expose-ports',
    '4173',
    ...(MODE === 'duration' ? ['--timeout', String(TIMEOUT_MINUTES)] : []),
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
  return { ...session, publicUrl: publicRoute(session.output(), APP_PORT) };
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

async function verifyDurationSession(session) {
  check('dedicated session duration', report.timeoutMinutes === 120, `timeout=${report.timeoutMinutes} minutes`);
  const marker = markerFor('duration-output');
  session.write(remoteMarkerCommand(marker));
  await session.waitFor(marker, MARKER_TIMEOUT_MS);
  check('duration path process output', true, 'marker reached the foreground process through the public CLI PTY');
  session.write(Buffer.from([0x1d]));
  await session.waitForExit(CLI_TIMEOUT_MS);
  check('duration path clean detach', true, 'Ctrl-] released the public CLI terminal');
}

async function verifyReconnectSession(stateHome, initial) {
  const fixtureMarker = markerFor('http-fixture');
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
  await stopFixture(initial.publicUrl, fixtureMarker);
  await verifySnapshotBoundary(stateHome, { ...startedIdentity, socket: report.initial.socket });
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
  const accepted = exitCode === 0 || /No Vercel sandbox|No matching Vercel sandbox|nothing to remove/i.test(output);
  return { attempted: true, exitCode, accepted };
}

async function runAction(stateHome, args) {
  const session = createPty([CLI_PATH, ...args], stateHome);
  const exitCode = await session.waitForExit(CLI_TIMEOUT_MS);
  return { exitCode, output: session.output() };
}

async function verifySnapshotBoundary(stateHome, priorIdentity) {
  const priorFile = `/tmp/devbox-uat-prior-${randomBytes(8).toString('hex')}`;
  const startedMarker = markerFor('snapshot-process-started');
  const endedMarker = markerFor('snapshot-process-ended');
  const absentMarker = markerFor('snapshot-process-absent');
  let previous;
  let resumed;
  try {
    previous = await attachSession(stateHome);
    previous.write(remoteDetachedProcessCommand(startedMarker, endedMarker, priorFile));
    await previous.waitFor(startedMarker, MARKER_TIMEOUT_MS);
    previous.write(Buffer.from([0x1d]));
    await previous.waitForExit(CLI_TIMEOUT_MS);

    const paused = await runAction(stateHome, [BRANCH, '--provider', 'vercel', '--pause']);
    check('snapshot pause', paused.exitCode === 0, 'the public CLI retained a snapshot');

    resumed = createPty([
      CLI_PATH,
      BRANCH,
      '--provider',
      'vercel',
      '--expose-ports',
      '4173',
    ], stateHome);
    await resumed.waitFor('prior user processes ended', CLI_TIMEOUT_MS);
    await resumed.waitFor(`session duration: ${TIMEOUT_MINUTES} minutes`, CLI_TIMEOUT_MS);
    await resumed.waitFor('▲ ', CLI_TIMEOUT_MS);
    publicRoute(resumed.output(), APP_PORT);
    check('snapshot public route returned', true, 'the new VM session published the requested app route');
    const freshIdentity = await readIdentity(resumed, 'snapshot-attach');
    check('snapshot fresh socket', freshIdentity.socket !== priorIdentity.socket, 'snapshot resume received a new session-derived socket');
    check('snapshot fresh tmux session', freshIdentity.session === 'devbox', `session=${freshIdentity.session}`);
    resumed.write(remoteFileAbsentCommand(absentMarker, priorFile));
    await resumed.waitFor(absentMarker, MARKER_TIMEOUT_MS);
    check('snapshot prior process ended', true, 'the new VM session did not retain the prior user process');
    resumed.write(Buffer.from([0x1d]));
    await resumed.waitForExit(CLI_TIMEOUT_MS);
    report.snapshot = {
      notice: true,
      socketChanged: true,
      priorProcessEnded: true,
      runtimeServicesRefreshed: true,
    };
  } finally {
    if (previous) await previous.close('SIGTERM');
    if (resumed) await resumed.close('SIGTERM');
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

function remoteMarkerCommand(marker) {
  const encoded = Buffer.from(marker).toString('base64');
  return `printf '%s\\n' "$(printf '%s' '${encoded}' | base64 -d)"\n`;
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
  return `rm -f -- '${path}'; (sleep 60; printf '%s' "$(printf '%s' '${completionEncoded}' | base64 -d)" > '${path}') >/dev/null 2>&1 & printf '%s\\n' "$(printf '%s' '${startedEncoded}' | base64 -d)"\n`;
}

function remoteFileAbsentCommand(marker, path) {
  const encoded = Buffer.from(marker).toString('base64');
  return `if [ ! -e '${path}' ]; then printf '%s\\n' "$(printf '%s' '${encoded}' | base64 -d)"; else printf 'DEVBOX_UAT_PRIOR_PROCESS_PRESENT\\n'; fi\n`;
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
  const match = new RegExp('^\\s*' + port + ':\\s+(https://[^\\s]+)\\s+\\(', 'm').exec(output);
  if (!match) throw new Error('CLI output did not include the public route for port ' + port);
  return match[1];
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
