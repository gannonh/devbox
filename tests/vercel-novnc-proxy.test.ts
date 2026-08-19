import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const PROXY = 'images/vercel/novnc-proxy.mjs';
const CODE = 'test-novnc-password-aaaaaaaaaaaaaaaa';
const WRONG_CODE = 'test-novnc-password-bbbbbbbbbbbbbbbb';
const COOKIE = `devbox_novnc=${CODE}`;

let child: ChildProcess | undefined;
let upstream: http.Server | undefined;
let upstreamHttpHeaders: http.IncomingHttpHeaders | undefined;
let upstreamWebSocketHeaders: http.IncomingHttpHeaders | undefined;

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await new Promise<void>((resolve) => upstream ? upstream.close(() => resolve()) : resolve());
  upstream = undefined;
  upstreamHttpHeaders = undefined;
  upstreamWebSocketHeaders = undefined;
});

describe('noVNC access-code pairing proxy', () => {
  it('pairs a code into a cookie, scrubs it from the URL, and never forwards it upstream', async () => {
    const upstreamPort = await listenUpstream();
    const proxyPort = await listenProxy(upstreamPort);
    const base = `http://127.0.0.1:${proxyPort}`;

    // An unpaired browser gets the form rather than an upstream response.
    const unpaired = await fetch(`${base}/vnc.html`, { redirect: 'manual' });
    expect(unpaired.status).toBe(200);
    expect(await unpaired.text()).toContain('Access code');
    expect(upstreamHttpHeaders).toBeUndefined();

    // The printed link pairs on click and redirects the code out of the URL.
    const paired = await fetch(`${base}/vnc.html?token=${CODE}&autoconnect=1`, { redirect: 'manual' });
    expect(paired.status).toBe(303);
    expect(paired.headers.get('location')).toBe('/vnc.html?autoconnect=1');
    const setCookie = paired.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`devbox_novnc=${CODE}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    const wrongQuery = await fetch(`${base}/vnc.html?token=${WRONG_CODE}`, { redirect: 'manual' });
    expect(wrongQuery.status).toBe(401);
    expect(wrongQuery.headers.get('set-cookie')).toBeNull();

    // Pasting the code into the form pairs the same way.
    const form = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${CODE}`,
      redirect: 'manual',
    });
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/vnc.html?autoconnect=1');

    const wrongForm = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${WRONG_CODE}`,
      redirect: 'manual',
    });
    expect(wrongForm.status).toBe(401);
    expect(wrongForm.headers.get('set-cookie')).toBeNull();

    // A paired cookie reaches the upstream, which never sees the credential.
    const viewer = await fetch(`${base}/vnc.html?autoconnect=1`, { headers: { cookie: COOKIE } });
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toBe('upstream:/vnc.html?autoconnect=1');
    expect(upstreamHttpHeaders?.cookie).toBeUndefined();
    expect(upstreamHttpHeaders?.authorization).toBeUndefined();

    // The WebSocket upgrade pairs by cookie and is refused without one.
    expect(await upgrade(proxyPort, {})).toContain('401 Unauthorized');
    expect(await upgrade(proxyPort, { cookie: `devbox_novnc=${WRONG_CODE}` })).toContain('401 Unauthorized');

    expect(await upgrade(proxyPort, {
      cookie: COOKIE,
      'proxy-authenticate': 'Basic realm="upstream"',
      'proxy-authorization': 'Basic should-not-forward',
    })).toContain('101 Switching Protocols');
    expect(upstreamWebSocketHeaders?.cookie).toBeUndefined();
    expect(upstreamWebSocketHeaders?.authorization).toBeUndefined();
    expect(upstreamWebSocketHeaders?.['proxy-authenticate']).toBeUndefined();
    expect(upstreamWebSocketHeaders?.['proxy-authorization']).toBeUndefined();
  });
});

function listenUpstream(): Promise<number> {
  return new Promise((resolve, reject) => {
    upstream = http.createServer((request, response) => {
      upstreamHttpHeaders = request.headers;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`upstream:${request.url}`);
    });
    upstream.on('upgrade', (request, socket) => {
      upstreamWebSocketHeaders = request.headers;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.end();
    });
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => {
      const address = upstream?.address();
      if (!address || typeof address === 'string') reject(new Error('upstream bind failed'));
      else resolve(address.port);
    });
  });
}

function listenProxy(upstreamPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('proxy port bind failed'));
        return;
      }
      const port = address.port;
      server.close(() => {
        child = spawn('node', [PROXY], {
          env: {
            ...process.env,
            DEVBOX_NOVNC_PASSWORD: CODE,
            DEVBOX_NOVNC_BIND: '127.0.0.1',
            DEVBOX_NOVNC_PORT: String(port),
            DEVBOX_NOVNC_INTERNAL_PORT: String(upstreamPort),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const timer = setTimeout(() => reject(new Error('proxy start timeout')), 5_000);
        child.stderr?.on('data', (chunk) => {
          if (String(chunk).includes('listening')) {
            clearTimeout(timer);
            resolve(port);
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`proxy exited ${code}`));
        });
      });
    });
  });
}

function upgrade(port: number, headers: {
  cookie?: string;
  authorization?: string;
  'proxy-authenticate'?: string;
  'proxy-authorization'?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const extra = [
      headers.cookie ? `Cookie: ${headers.cookie}` : '',
      headers.authorization ? `Authorization: ${headers.authorization}` : '',
      headers['proxy-authenticate'] ? `Proxy-Authenticate: ${headers['proxy-authenticate']}` : '',
      headers['proxy-authorization'] ? `Proxy-Authorization: ${headers['proxy-authorization']}` : '',
    ].filter(Boolean).map((header) => `${header}\r\n`).join('');
    socket.once('connect', () => {
      socket.write(
        `GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
        + extra
        + '\r\n',
      );
    });
    socket.once('data', (data) => {
      socket.end();
      resolve(data.toString('utf8'));
    });
    socket.once('error', reject);
  });
}
