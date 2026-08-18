import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const PROXY = 'images/vercel/basic-auth-proxy.mjs';
const TOKEN = 'test-novnc-token-aaaaaaaaaaaaaaaaaaaa';

let child: ChildProcess | undefined;
let upstream: http.Server | undefined;

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await new Promise<void>((resolve) => upstream ? upstream.close(() => resolve()) : resolve());
  upstream = undefined;
});

describe('noVNC pairing proxy', () => {
  it('pairs with a URL token, cookie, or form code and rejects missing tokens', async () => {
    const upstreamPort = await listenUpstream();
    const proxyPort = await listenProxy(upstreamPort);
    const base = `http://127.0.0.1:${proxyPort}`;

    const missing = await fetch(`${base}/vnc.html`);
    const form = await missing.text();
    expect(missing.status).toBe(200);
    expect(form).toContain('name="token"');
    expect(form).toContain('<form');
    expect(missing.headers.get('www-authenticate')).toBeNull();

    const wrong = await fetch(`${base}/vnc.html?token=nope`);
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain('name="token"');

    const paired = await fetch(`${base}/vnc.html?token=${TOKEN}&autoconnect=1`);
    expect(paired.status).toBe(200);
    expect(await paired.text()).toBe('upstream:/vnc.html?token=' + TOKEN + '&autoconnect=1');
    const cookie = cookieFrom(paired);
    expect(cookie).toMatch(/^devbox_novnc=/);

    const cookied = await fetch(`${base}/vnc.html?autoconnect=1`, { headers: { cookie } });
    expect(cookied.status).toBe(200);
    expect(await cookied.text()).toBe('upstream:/vnc.html?autoconnect=1');

    const posted = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${TOKEN}`,
      redirect: 'manual',
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get('location')).toBe('/vnc.html?autoconnect=1');
    expect(cookieFrom(posted)).toMatch(/^devbox_novnc=/);

    expect(await upgrade(proxyPort, { cookie })).toContain('101');
    expect(await upgrade(proxyPort, {})).not.toContain('101');
  });
});

function cookieFrom(response: Response): string {
  return response.headers.getSetCookie()[0]?.split(';', 1)[0]
    ?? response.headers.get('set-cookie')?.split(';', 1)[0]
    ?? '';
}

function listenUpstream(): Promise<number> {
  return new Promise((resolve, reject) => {
    upstream = http.createServer((request, response) => {
      if (request.headers.connection === 'keep-alive') {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`upstream:${request.url}`);
    });
    upstream.on('upgrade', (_request, socket) => {
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
            DEVBOX_NOVNC_PASSWORD: TOKEN,
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

function upgrade(port: number, headers: { cookie?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const extra = headers.cookie ? `Cookie: ${headers.cookie}\r\n` : '';
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
      resolve(data.toString('utf8').split('\r\n', 1)[0] ?? '');
    });
    socket.once('error', reject);
  });
}
