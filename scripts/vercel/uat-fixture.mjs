#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const phase = process.argv[2];
const cwd = process.cwd();
const runtimeDirectory = '/vercel/.devbox/runtime';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function command(file, args, options = {}) {
  try {
    return await execFile(file, args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 1_000_000,
      ...options,
    });
  } catch (error) {
    const code = error?.code ?? 'unknown';
    const stderr = (typeof error?.stderr === 'string'
      ? error.stderr
      : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '')
      .trim()
      .slice(0, 300);
    throw new Error(`${file} failed with exit code ${code}${stderr ? `; ${stderr}` : ''}`);
  }
}

async function waitForFile(path, expected = 'ok\n') {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, 'utf8')) === expected) return;
    } catch {
      // The callback has not completed yet.
    }
    await delay(100);
  }
  throw new Error(`UAT callback did not complete: ${path}`);
}

async function waitForHttp(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The Vite process has not started listening yet.
    }
    await delay(100);
  }
  throw new Error('Vite server did not become ready');
}

function startCallbackServer(workspace, expectedCodes) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/oauth/callback') {
          response.writeHead(404).end();
          return;
        }
        const client = url.searchParams.get('client');
        const code = url.searchParams.get('code');
        const accepted = (client === 'chromium' || client === 'electron')
          && code === expectedCodes[client];
        if (accepted) await writeFile(join(workspace, `${client}.ok`), 'ok\n');
        response.writeHead(accepted ? 200 : 400, {
          'access-control-allow-origin': '*',
          'content-type': 'text/plain',
        });
        response.end(accepted ? 'ok' : 'rejected');
      } catch {
        response.writeHead(500).end();
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('UAT callback server did not expose a TCP port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2_000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startDisplay() {
  const password = randomBytes(24).toString('base64url');
  await command('/usr/local/bin/devbox-start', [], {
    env: { ...process.env, DEVBOX_NOVNC_PASSWORD: password },
  });
}

async function runInitial(refresh) {
  await startDisplay();
  for (const agent of ['pi', 'claude', 'codex', 'opencode']) {
    await command(agent, ['--version']);
  }

  const workspace = await mkdtemp(join(tmpdir(), 'devbox-uat-'));
  let callback;
  let vite;
  let chromium;
  let electron;
  try {
    await writeFile(join(workspace, 'package.json'), JSON.stringify({
      private: true,
      dependencies: { electron: '31.7.7', vite: '5.4.20' },
    }));
    await command('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'], {
      cwd: workspace,
      timeout: 300_000,
    });

    callback = await startCallbackServer(workspace, { chromium: refresh, electron: refresh });
    const callbackUrl = `http://127.0.0.1:${callback.port}/oauth/callback`;
    await writeFile(join(workspace, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>devbox UAT</title>
<body>oauth-pending</body>
<script>
  const client = new URLSearchParams(location.search).get('client') || 'chromium';
  const callback = ${JSON.stringify(callbackUrl)}
    + '?client=' + encodeURIComponent(client)
    + '&code=' + encodeURIComponent(${JSON.stringify(refresh)});
  fetch(callback).then((response) => {
    document.body.dataset.uat = response.ok ? 'ok' : 'failed';
    document.body.textContent = document.body.dataset.uat;
  });
</script>
`);
    await writeFile(join(workspace, 'electron-entry.cjs'), `const { app, BrowserWindow } = require('electron');

const url = process.env.UAT_URL;
let window;
async function main() {
  try {
    await app.whenReady();
    window = new BrowserWindow({ show: false });
    await window.loadURL(url);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await window.webContents.executeJavaScript('document.body.dataset.uat || ""');
      if (state === 'ok') process.exitCode = 0;
      if (state === 'ok' || state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(process.exitCode ?? 1);
  }
}

void main();
`);

    vite = spawn(join(workspace, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', '4173'], {
      cwd: workspace,
      stdio: 'ignore',
    });
    vite.once('error', () => {});
    await waitForHttp('http://127.0.0.1:4173/');

    chromium = spawn('chromium', [
      '--headless=new',
      '--no-first-run',
      '--disable-dev-shm-usage',
      `--user-data-dir=${join(workspace, 'chromium-profile')}`,
      'http://127.0.0.1:4173/?client=chromium',
    ], { cwd: workspace, stdio: 'ignore' });
    chromium.once('error', () => {});
    await waitForFile(join(workspace, 'chromium.ok'));
    await stopProcess(chromium);

    electron = spawn(join(workspace, 'node_modules/.bin/electron'), [
      '--no-sandbox',
      '--disable-gpu',
      'electron-entry.cjs',
    ], {
      cwd: workspace,
      env: { ...process.env, UAT_URL: 'http://127.0.0.1:4173/?client=electron' },
      stdio: 'ignore',
    });
    const electronExit = new Promise((resolve, reject) => {
      electron.once('error', reject);
      electron.once('exit', (code) => resolve(code));
    });
    const code = await electronExit;
    if (code !== 0) throw new Error(`Electron fixture exited with code ${code}`);
    await waitForFile(join(workspace, 'electron.ok'));

    const branch = (await command('git', ['branch', '--show-current'])).stdout.trim();
    if (!branch) throw new Error('UAT push requires a checked-out branch');
    const markerPath = `.devbox-uat-${Date.now()}.txt`;
    await writeFile(join(cwd, markerPath), `uat-${Date.now()}\n`);
    await command('git', ['add', '--', markerPath]);
    await command('git', ['-c', 'user.name=devbox-uat', '-c', 'user.email=devbox-uat@example.invalid', 'commit', '-m', 'test: record disposable UAT push']);
    await command('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
    await command('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]);
    await writeFile(join(runtimeDirectory, 'uat-push-proof'), `${branch}\n`, { mode: 0o600 });
    await rm(join(cwd, markerPath), { force: true });
  } finally {
    await stopProcess(electron);
    await stopProcess(chromium);
    await stopProcess(vite);
    if (callback) await new Promise((resolve) => callback.server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runResume(refresh) {
  const proof = (await readFile(join(runtimeDirectory, 'uat-push-proof'), 'utf8')).trim();
  if (!proof) throw new Error('UAT push proof is missing after Sandbox resume');
  const branch = (await command('git', ['branch', '--show-current'])).stdout.trim();
  if (branch !== proof) throw new Error('UAT resumed on a different branch');
  await command('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]);
  if (!refresh) throw new Error('UAT runtime secret refresh is empty');
  return refresh;
}

async function main() {
  if (phase !== 'initial' && phase !== 'resume') throw new Error('UAT phase must be initial or resume');
  const refresh = process.env.DEVBOX_UAT_REFRESH;
  if (!refresh) throw new Error('UAT runtime secret refresh is missing');
  if (phase === 'initial') {
    await runInitial(refresh);
    process.stdout.write('DEVBOX_UAT:agents\nDEVBOX_UAT:chromium-oauth\nDEVBOX_UAT:electron-vite\nDEVBOX_UAT:push\n');
  } else {
    const observedRefresh = await runResume(refresh);
    process.stdout.write(`DEVBOX_UAT:resume-secret-refresh\nDEVBOX_UAT_REFRESH=${observedRefresh}\n`);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
