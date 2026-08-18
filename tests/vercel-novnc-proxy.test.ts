import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const PROXY = 'images/vercel/basic-auth-proxy.mjs';
const USERNAME = 'devbox';
const PASSWORD = 'test-novnc-password-aaaaaaaaaaaaaaaa';
const AUTHORIZATION = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
const WRONG_AUTHORIZATION = `Basic ${Buffer.from(`${USERNAME}:wrong-password`).toString('base64')}`;

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

describe('noVNC Basic Auth proxy', () => {
  it('requires HTTP Basic Auth and strips Authorization before HTTP/WebSocket forwarding', async () => {
    const upstreamPort = await listenUpstream();
    const proxyPort = await listenProxy(upstreamPort);
    const base = `http://127.0.0.1:${proxyPort}`;

    const missing = await fetch(`${base}/vnc.html`, { redirect: 'manual' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Basic realm="devbox"');

    const wrong = await fetch(`${base}/vnc.html`, {
      headers: { authorization: WRONG_AUTHORIZATION },
      redirect: 'manual',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Basic realm="devbox"');

    const query = await fetch(`${base}/vnc.html?token=${PASSWORD}`, { redirect: 'manual' });
    expect(query.status).toBe(401);

    const cookie = await fetch(`${base}/vnc.html`, {
      headers: { cookie: `devbox_novnc=${PASSWORD}` },
      redirect: 'manual',
    });
    expect(cookie.status).toBe(401);

    const form = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${PASSWORD}`,
      redirect: 'manual',
    });
    expect(form.status).toBe(401);

    const authorized = await fetch(`${base}/vnc.html?autoconnect=1`, {
      headers: { authorization: AUTHORIZATION },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe('upstream:/vnc.html?autoconnect=1');
    expect(upstreamHttpHeaders?.authorization).toBeUndefined();

    const missingWebSocket = await upgrade(proxyPort, {});
    expect(missingWebSocket).toContain('401 Unauthorized');
    expect(missingWebSocket.toLowerCase()).toContain('www-authenticate: basic realm="devbox"');

    const wrongWebSocket = await upgrade(proxyPort, { authorization: WRONG_AUTHORIZATION });
    expect(wrongWebSocket).toContain('401 Unauthorized');
    expect(wrongWebSocket.toLowerCase()).toContain('www-authenticate: basic realm="devbox"');

    expect(await upgrade(proxyPort, {
      authorization: AUTHORIZATION,
      'proxy-authenticate': 'Basic realm="upstream"',
      'proxy-authorization': 'Basic should-not-forward',
    })).toContain('101 Switching Protocols');
    expect(upstreamWebSocketHeaders?.authorization).toBeUndefined();
    expect(upstreamWebSocketHeaders?.cookie).toBeUndefined();
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
            DEVBOX_NOVNC_PASSWORD: PASSWORD,
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
  authorization?: string;
  'proxy-authenticate'?: string;
  'proxy-authorization'?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const extra = [
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
