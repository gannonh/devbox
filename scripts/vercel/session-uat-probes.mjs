import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, Snapshot } from '@vercel/sandbox';
import { delay, markerFor, shellQuote, signalCode } from './session-uat-evidence.mjs';
import { fetchTextWithTimeout, fetchWithTimeout } from './http-probe.mjs';

const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const FIXTURE_REQUEST_TIMEOUT_MS = 10_000;

export function createSessionUatProbes({
  branch,
  repoRoot,
  cliPath,
  environment = process.env,
  markerTimeoutMs,
  providerPollMs,
  redact,
}) {
  async function readProviderSessionFacts(stateHome, sandboxName = undefined, signal = undefined) {
    const name = sandboxName ?? await readStoredSandboxName(stateHome);
    let sandbox;
    try {
      sandbox = await Sandbox.get({
        ...providerCredentials(environment),
        name,
        resume: false,
        signal: signal ?? AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
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
      if (identity?.branch === branch && typeof identity.name === 'string' && identity.name) return identity.name;
    }
    throw new Error('Vercel UAT metadata did not contain the branch Sandbox name');
  }

  async function listProviderSnapshots(sandboxName, signal = undefined) {
    try {
      const page = await Snapshot.list({
        ...providerCredentials(environment),
        name: sandboxName,
        limit: 50,
        signal: signal ?? AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
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
        const signal = AbortSignal.timeout(Math.min(PROVIDER_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
        snapshots = await listProviderSnapshots(sandboxName, signal);
        const retained = snapshots.filter((snapshot) => snapshot.status === 'created');
        if (retained.length === 1) return retained;
      } catch (error) {
        lastError = error;
      }
      await delay(Math.min(providerPollMs, Math.max(1, deadline - Date.now())));
    }
    if (lastError) throw new Error('Vercel provider snapshot probe did not converge');
    throw new Error(`Vercel provider did not retain exactly one created snapshot; found ${snapshots.filter((snapshot) => snapshot.status === 'created').length}`);
  }

  async function waitForProviderStop(sandboxName, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let facts;
      try {
        const signal = AbortSignal.timeout(Math.min(PROVIDER_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
        facts = await readProviderSessionFacts(undefined, sandboxName, signal);
      } catch {
        facts = undefined;
      }
      if (facts && ['stopped', 'aborted'].includes(facts.status)) {
        const terminalAt = facts.status === 'aborted' ? facts.abortedAt : facts.stoppedAt;
        if (terminalAt) return { ...facts, terminalAt, observedAt: new Date().toISOString() };
      }
      await delay(Math.min(providerPollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error('Vercel provider Sandbox did not stop before the UAT deadline');
  }

  async function waitForDeadline(deadline) {
    while (Date.now() < deadline) {
      await delay(Math.min(30_000, Math.max(1, deadline - Date.now())));
    }
    return Date.now();
  }

  function createPty(args, stateHome) {
    const command = [process.execPath, ...args].map(shellQuote).join(' ');
    const child = spawn('script', ['-qefc', command, '/dev/null'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...environment,
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
        if (child.exitCode !== null || child.signalCode !== null) {
          return child.exitCode ?? signalCode(child.signalCode);
        }
        child.kill(signal);
        return waitForExit(child, 5_000).catch(() => {
          child.kill('SIGKILL');
          return waitForExit(child, 5_000);
        });
      },
    };
  }

  async function attachSession(stateHome) {
    return createPty([cliPath, branch, '--provider', 'vercel', '--attach'], stateHome);
  }

  async function readIdentity(session, label) {
    const marker = markerFor(label);
    const wait = session.waitFor(marker, markerTimeoutMs);
    session.write(remoteIdentityCommand(marker));
    const retry = setInterval(() => {
      if (!session.output().includes(marker)) session.write(remoteIdentityCommand(marker));
    }, 2_000);
    try {
      await wait;
      return parseIdentity(session.output(), marker);
    } finally {
      clearInterval(retry);
    }
  }

  async function waitForFixture(url, marker) {
    const deadline = Date.now() + markerTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const { response, body } = await fetchTextWithTimeout(
          new URL('/', url),
          {},
          Math.min(FIXTURE_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        );
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
    const { response, body } = await fetchTextWithTimeout(
      new URL('/shutdown', url),
      {},
      FIXTURE_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok || body !== 'fixture-stopping\n') throw new Error('HTTP fixture did not accept shutdown');
    const deadline = Date.now() + markerTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const { response: probe, body: probeBody } = await fetchTextWithTimeout(
          new URL('/', url),
          {},
          Math.min(FIXTURE_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        );
        if (!probe.ok || !probeBody.includes(marker)) return;
      } catch {
        return;
      }
      await delay(250);
    }
    throw new Error('HTTP fixture did not stop');
  }

  async function waitForPublicRoute(url) {
    const deadline = Date.now() + markerTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetchWithTimeout(
          url,
          { redirect: 'manual' },
          Math.min(FIXTURE_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        );
        await response.body?.cancel();
        return { reachable: true, status: response.status };
      } catch {
        await delay(250);
      }
    }
    throw new Error('public route did not respond before the deadline');
  }

  return {
    attachSession,
    createPty,
    markerFor,
    parseDetachedProcessStartup,
    parseFixtureStartup,
    parseIdentity,
    parseWorkspace,
    publicRoute,
    providerCredentials,
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
  };
}

export function providerCredentials(environment = process.env) {
  const token = environment.VERCEL_TOKEN?.trim();
  const teamId = environment.VERCEL_TEAM_ID?.trim();
  const projectId = environment.VERCEL_PROJECT_ID?.trim();
  if (!token || !teamId || !projectId) {
    throw new Error('VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are required for provider probes');
  }
  return { token, teamId, projectId };
}

export function sessionSocketPath(sessionId) {
  return `/tmp/devbox-tmux/session-${Buffer.from(sessionId, 'utf8').toString('base64url')}/socket`;
}

export function waitForOutput(child, probe, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    let settled = false;
    const onData = () => {
      try {
        const result = probe();
        if (result) finish(result);
      } catch (error) {
        finish(error);
      }
    };
    const onExit = () => finish(new Error('CLI PTY exited before the marker appeared'));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onData);
      child.removeListener('exit', onExit);
      if (value instanceof Error) reject(value);
      else resolvePromise(value);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(new Error('CLI PTY marker timeout')), timeoutMs);
    if (settled) {
      clearTimeout(timer);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(new Error('CLI PTY exited before the marker appeared'));
      return;
    }
    try {
      const found = probe();
      if (found) finish(found);
    } catch (error) {
      finish(error);
    }
  });
}

export function waitForExit(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    let settled = false;
    const onExit = (code, signal) => finish(undefined, code ?? signalCode(signal));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolvePromise(value);
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(undefined, child.exitCode ?? signalCode(child.signalCode));
      return;
    }
    timer = setTimeout(() => finish(new Error('CLI PTY exit timeout')), timeoutMs);
    if (settled) clearTimeout(timer);
  });
}

function remoteIdentityCommand(marker) {
  const encoded = Buffer.from(marker).toString('base64');
  return `printf 'PID=%s TMUX=%s SOCKET=%s\\n%s\\n' "$$" "$(tmux display-message -p '#S')" "$(find /tmp/devbox-tmux -mindepth 2 -maxdepth 2 -type s -name socket -print | head -n 1)" "$(printf '%s' '${encoded}' | base64 -d)"\n`;
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
    "print(f'PID={os.getpid()} TMUX={SESSION}\\n{MARKER}', flush=True)",
    'server.serve_forever()',
  ].join('\n');
  const encoded = Buffer.from(code).toString('base64');
  return `python3 -c "$(printf '%s' '${encoded}' | base64 -d)"\n`;
}

function remoteDetachedProcessCommand(started, completion, path) {
  const startedEncoded = Buffer.from(started).toString('base64');
  const completionEncoded = Buffer.from(completion).toString('base64');
  return `set -eu; rm -f -- ${shellQuote(path)}; printf '%s\\n' "$(printf '%s' '${completionEncoded}' | base64 -d)" > ${shellQuote(path)}; test -f ${shellQuote(path)} && grep -Fqx "$(printf '%s' '${completionEncoded}' | base64 -d)" ${shellQuote(path)}; (sh -c 'while :; do sleep 30; done' ${shellQuote(completion)}) >/dev/null 2>&1 & printf 'PID=%s MARKER=%s\\n%s\\n' "$!" "$(printf '%s' '${completionEncoded}' | base64 -d)" "$(printf '%s' '${startedEncoded}' | base64 -d)"\n`;
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
  return `printf 'PWD=%s BRANCH=%s\\n%s\\n' "$PWD" "$(git branch --show-current)" "$(printf '%s' '${encoded}' | base64 -d)"\n`;
}

function remoteRuntimeStateCommand(ready, missing, sessionId) {
  const readyEncoded = Buffer.from(ready).toString('base64');
  const missingEncoded = Buffer.from(missing).toString('base64');
  return `if [ -s '/vercel/.devbox/runtime/preparation.json' ] && grep -Fq ${shellQuote(sessionId)} '/vercel/.devbox/runtime/preparation.json' && [ -s '/vercel/.devbox/runtime/setup.status' ] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"(running|succeeded)"' '/vercel/.devbox/runtime/setup.status'; then printf '%s\\n' "$(printf '%s' '${readyEncoded}' | base64 -d)"; else printf '%s\\n' "$(printf '%s' '${missingEncoded}' | base64 -d)"; fi\n`;
}

function parseIdentity(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`PID=([0-9]+) TMUX=([^\\s\\r\\n]+) SOCKET=([^\\s\\r\\n]+)\\s+${escaped}`).exec(output);
  if (!match) throw new Error(`identity marker ${marker} did not include a PID, tmux session, and socket`);
  return { pid: match[1], session: match[2], socket: match[3] };
}

function parseFixtureStartup(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`PID=([0-9]+) TMUX=([^\\s\\r\\n]+)\\s+${escaped}`).exec(output);
  if (!match) throw new Error('fixture marker did not include a PID and tmux session');
  return { marker, pid: match[1], session: match[2] };
}

function parseDetachedProcessStartup(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`PID=([0-9]+) MARKER=([^\\s\\r\\n]+)\\s+${escaped}`).exec(output);
  if (!match) throw new Error('detached process marker did not include a PID and process marker');
  return { marker: match[2], pid: match[1] };
}

function parseWorkspace(output, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`PWD=([^\\s\\r\\n]+) BRANCH=([^\\s\\r\\n]+)\\s+${escaped}`).exec(output);
  if (!match) throw new Error('workspace marker did not include the working directory and branch');
  return { path: match[1], branch: match[2] };
}

function publicRoute(output, port) {
  const match = routeMatch(output, port);
  if (!match) throw new Error('CLI output did not include the public route for port ' + port);
  return match[1];
}

function routeMatch(output, port) {
  return new RegExp('^\\s*' + port + ':\\s+(https://[^\\s]+)\\s+\\(', 'm').exec(output);
}

function matches(output, pattern) {
  if (typeof pattern === 'string') return output.includes(pattern) ? pattern : undefined;
  return pattern.test(output) ? pattern : undefined;
}
