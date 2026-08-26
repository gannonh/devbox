import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Public-boundary tests for the app relay.
 *
 * These drive the real `images/vercel/app-relay.mjs` over a real socket
 * against a loopback-only upstream, because every claim this file makes --
 * the header contract, streaming, trailers, the bounded pre-listen failure,
 * and the refusal to be a general proxy -- is only true of the process as it
 * actually runs inside the Sandbox.
 */
const RELAY = 'images/vercel/app-relay.mjs';

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  // An upgraded socket is detached from the server's request lifecycle, so
  // close() alone would wait on a tunnel that is meant to stay open.
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Upstream {
  port: number;
  lastHeaders(): http.IncomingHttpHeaders | undefined;
  lastUpgradeHeaders(): http.IncomingHttpHeaders | undefined;
  lastRequestLine(): string | undefined;
  lastBody(): string;
  upgradeCount(): number;
}

async function startUpstream(options: {
  host?: string;
  onRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
} = {}): Promise<Upstream> {
  let headers: http.IncomingHttpHeaders | undefined;
  let upgradeHeaders: http.IncomingHttpHeaders | undefined;
  let requestLine: string | undefined;
  let body = '';
  let upgrades = 0;

  const server = http.createServer((request, response) => {
    headers = request.headers;
    requestLine = `${request.method} ${request.url}`;
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    if (options.onRequest) {
      options.onRequest(request, response);
      return;
    }
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`upstream:${request.url}`);
    });
  });
  server.on('upgrade', (request, socket) => {
    upgrades += 1;
    upgradeHeaders = request.headers;
    requestLine = `${request.method} ${request.url}`;
    const accepted = request.headers['sec-websocket-protocol']?.split(',')[0]?.trim();
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + (accepted ? `Sec-WebSocket-Protocol: ${accepted}\r\n` : '')
      + '\r\n',
    );
    socket.write('upstream-frame');
    socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString('utf8')}`));
  });
  server.on('connection', (socket) => sockets.push(socket));
  servers.push(server);
  // Loopback only: the whole point is that this listener is not reachable
  // from outside the Sandbox and the relay is.
  server.listen(0, options.host ?? '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('upstream bind failed');
  return {
    port: address.port,
    lastHeaders: () => headers,
    lastUpgradeHeaders: () => upgradeHeaders,
    lastRequestLine: () => requestLine,
    lastBody: () => body,
    upgradeCount: () => upgrades,
  };
}

async function startRelay(target: number, env: Record<string, string> = {}): Promise<number> {
  const child = spawn('node', [RELAY], {
    env: {
      ...process.env,
      DEVBOX_RELAY_TARGET_PORT: String(target),
      DEVBOX_RELAY_BIND: '127.0.0.1',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  return new Promise<number>((resolve, reject) => {
    let output = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /listening (\d+) ->/.exec(output);
      if (match?.[1]) resolve(Number(match[1]));
    });
    child.once('exit', (code) => reject(new Error(`relay exited with ${code}: ${output}`)));
    setTimeout(() => reject(new Error(`relay never listened: ${output}`)), 10_000).unref();
  });
}

function rawRequest(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(message));
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(received);
    }, 4_000).unref();
  });
}

describe('app relay HTTP boundary', () => {
  it('rewrites Host, keeps Origin and credentials, and replaces client forwarding claims', async () => {
    const upstream = await startUpstream();
    const relayPort = await startRelay(upstream.port);

    const response = await fetch(`http://127.0.0.1:${relayPort}/app?q=1`, {
      headers: {
        origin: 'https://app.example',
        cookie: 'session=abc',
        authorization: 'Bearer app-token',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
        forwarded: 'for=203.0.113.9;host=evil.example',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upstream:/app?q=1');
    const headers = upstream.lastHeaders();
    // The rewritten Host is the compatibility contract: it is what makes a
    // default Vite dev server answer a Sandbox route at all.
    expect(headers?.host).toBe(`localhost:${upstream.port}`);
    // The app's own origin policy stays the app's decision.
    expect(headers?.origin).toBe('https://app.example');
    expect(headers?.cookie).toBe('session=abc');
    expect(headers?.authorization).toBe('Bearer app-token');
    // Spoofed forwarding claims are replaced by what the relay observed.
    expect(headers?.['x-forwarded-host']).toBe(`127.0.0.1:${relayPort}`);
    expect(headers?.['x-forwarded-proto']).toBe('https');
    expect(headers?.['x-forwarded-for']).toBe('127.0.0.1');
    expect(headers?.forwarded).toBeUndefined();
  });

  it('preserves method, body, status, end-to-end headers, and trailers', async () => {
    const upstream = await startUpstream({
      onRequest: (request, response) => {
        request.on('end', () => {
          response.writeHead(201, {
            'content-type': 'application/json',
            'x-app-header': 'kept',
            trailer: 'x-app-trailer',
            connection: 'keep-alive',
          });
          response.addTrailers({ 'x-app-trailer': 'done' });
          response.end('{"ok":true}');
        });
      },
    });
    const relayPort = await startRelay(upstream.port);

    const raw = await rawRequest(
      relayPort,
      'POST /submit HTTP/1.1\r\n'
      + `host: 127.0.0.1:${relayPort}\r\n`
      + 'content-length: 7\r\n'
      + 'te: trailers\r\n'
      + 'x-hop: dropped\r\n'
      + 'connection: close, x-hop\r\n\r\n'
      + 'payload',
    );

    expect(raw).toContain('HTTP/1.1 201');
    expect(raw).toContain('x-app-header: kept');
    expect(raw).toContain('x-app-trailer: done');
    // The relay's own connection management never leaks upstream's.
    expect(raw.split('\r\n\r\n')[0]).not.toContain('keep-alive');
    expect(upstream.lastRequestLine()).toBe('POST /submit');
    expect(upstream.lastBody()).toBe('payload');
    // Hop-by-hop headers, including the ones Connection names, stop here.
    expect(upstream.lastHeaders()?.['x-hop']).toBeUndefined();
    expect(upstream.lastHeaders()?.te).toBeUndefined();
    expect(upstream.lastHeaders()?.connection).not.toContain('x-hop');
  });

  it('streams the first response chunk before the upstream finishes', async () => {
    let finish = () => {};
    const upstream = await startUpstream({
      onRequest: (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('first');
        // Held open: a buffering proxy cannot pass this test, only a streaming one.
        finish = () => response.end('last');
      },
    });
    const relayPort = await startRelay(upstream.port);

    const response = await fetch(`http://127.0.0.1:${relayPort}/stream`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no response body');
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe('first');
    finish();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('last');
  });

  it('keeps a connected upstream alive while it prepares a slow response', async () => {
    const upstream = await startUpstream({
      onRequest: (_request, response) => {
        const timer = setTimeout(() => response.end('slow-app'), 2_500);
        timer.unref();
      },
    });
    const relayPort = await startRelay(upstream.port);

    const response = await fetch(`http://127.0.0.1:${relayPort}/slow`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('slow-app');
  });

  it('reaches an IPv6-only loopback upstream', async () => {
    const upstream = await startUpstream({ host: '::1' });
    const relayPort = await startRelay(upstream.port);

    const response = await fetch(`http://127.0.0.1:${relayPort}/ipv6`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upstream:/ipv6');
  });

  it('answers a pre-listen route with a bounded generic 502 and no retry loop', async () => {
    // Nothing is listening on this port: exactly the window between the route
    // being published and the developer starting their dev server.
    const closed = await startUpstream();
    const target = closed.port;
    await new Promise<void>((resolve) => servers.splice(servers.indexOf(
      servers[servers.length - 1]!,
    ), 1)[0]!.close(() => resolve()));
    const relayPort = await startRelay(target);

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${relayPort}/`);
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(256);
    expect(body).not.toMatch(/\/vercel|\/usr|at .*app-relay|Error:/);
  });

  it('serves the app on the same URL once it starts listening, with no route change', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') reject(new Error('probe failed'));
        else probe.close(() => resolve(address.port));
      });
    });
    const relayPort = await startRelay(port);

    expect((await fetch(`http://127.0.0.1:${relayPort}/`)).status).toBe(502);

    const late = http.createServer((_request, response) => response.end('late-app'));
    servers.push(late);
    late.listen(port, '127.0.0.1');
    await once(late, 'listening');

    const served = await fetch(`http://127.0.0.1:${relayPort}/`);
    expect(await served.text()).toBe('late-app');
  });
});

describe('app relay WebSocket boundary', () => {
  it('tunnels an upgrade with its subprotocol, headers, and bidirectional frames', async () => {
    const upstream = await startUpstream();
    const relayPort = await startRelay(upstream.port);

    const socket = net.connect(relayPort, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET /hmr?token=1 HTTP/1.1\r\n'
      + `host: 127.0.0.1:${relayPort}\r\n`
      + 'upgrade: websocket\r\n'
      + 'connection: Upgrade\r\n'
      + 'origin: https://app.example\r\n'
      + 'cookie: session=abc\r\n'
      + 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      + 'sec-websocket-version: 13\r\n'
      + 'sec-websocket-protocol: vite-hmr\r\n\r\n',
    );

    let received = '';
    const done = new Promise<void>((resolve) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.includes('echo:client-frame')) resolve();
      });
    });
    await new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (received.includes('upstream-frame')) {
          clearInterval(wait);
          resolve();
        }
      }, 10);
    });
    socket.write('client-frame');
    await done;
    socket.destroy();

    expect(received).toContain('101 Switching Protocols');
    expect(received).toContain('Sec-WebSocket-Protocol: vite-hmr');
    const headers = upstream.lastUpgradeHeaders();
    expect(upstream.lastRequestLine()).toBe('GET /hmr?token=1');
    expect(headers?.host).toBe(`localhost:${upstream.port}`);
    expect(headers?.origin).toBe('https://app.example');
    expect(headers?.cookie).toBe('session=abc');
    expect(headers?.['sec-websocket-protocol']).toBe('vite-hmr');
    expect(headers?.['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(headers?.upgrade).toBe('websocket');
    expect(headers?.['x-forwarded-proto']).toBe('https');
  });

  it('closes a malformed upgrade without opening an upstream connection', async () => {
    const upstream = await startUpstream();
    const relayPort = await startRelay(upstream.port);

    const response = await rawRequest(
      relayPort,
      'GET http://elsewhere.example/ HTTP/1.1\r\n'
      + 'host: not a host\r\n'
      + 'upgrade: websocket\r\n'
      + 'connection: Upgrade\r\n\r\n',
    );

    expect(response).toContain('400 Bad Request');
    expect(upstream.upgradeCount()).toBe(0);
  });
});

describe('app relay is not an open proxy', () => {
  it('refuses a malformed authority and an absolute-form target', async () => {
    const upstream = await startUpstream();
    const relayPort = await startRelay(upstream.port);

    const malformed = await rawRequest(
      relayPort,
      `GET / HTTP/1.1\r\nhost: bad host name\r\nconnection: close\r\n\r\n`,
    );
    const absolute = await rawRequest(
      relayPort,
      'GET http://elsewhere.example/steal HTTP/1.1\r\n'
      + `host: 127.0.0.1:${relayPort}\r\nconnection: close\r\n\r\n`,
    );

    expect(malformed).toContain('400 Bad Request');
    expect(absolute).toContain('400 Bad Request');
    // No request reached the one upstream this relay is allowed to reach.
    expect(upstream.lastRequestLine()).toBeUndefined();
  });

  it('refuses an authority port outside the valid range', async () => {
    const upstream = await startUpstream();
    const relayPort = await startRelay(upstream.port);

    const response = await rawRequest(
      relayPort,
      `GET / HTTP/1.1\r\nhost: 127.0.0.1:65536\r\nconnection: close\r\n\r\n`,
    );

    expect(response).toContain('400 Bad Request');
    expect(upstream.lastRequestLine()).toBeUndefined();
  });

  it('sends every request to its fixed target whatever the request claims', async () => {
    const intended = await startUpstream();
    const other = await startUpstream();
    const relayPort = await startRelay(intended.port);

    await fetch(`http://127.0.0.1:${relayPort}/`, {
      headers: {
        'x-forwarded-host': `127.0.0.1:${other.port}`,
        forwarded: `host=127.0.0.1:${other.port}`,
      },
    });

    expect(intended.lastRequestLine()).toBe('GET /');
    expect(other.lastRequestLine()).toBeUndefined();
  });

  it.each([5900, 6080, 6081])('refuses to target the private display port %i', async (port) => {
    await expect(startRelay(port)).rejects.toThrow(/reserved display port/);
  });

  it('never accepts a listener port that collides with the app or the display', async () => {
    const upstream = await startUpstream();
    // Ask for a forbidden listener explicitly: the relay must fall back to a
    // kernel-chosen port rather than take it.
    const relayPort = await startRelay(upstream.port, {
      DEVBOX_RELAY_LISTEN_PORT: '6080',
      DEVBOX_RELAY_FORBIDDEN_PORTS: '5173,3000',
    });

    expect(relayPort).not.toBe(6080);
    expect(relayPort).not.toBe(5173);
    expect(relayPort).not.toBe(3000);
    expect(relayPort).not.toBe(upstream.port);
  });

  it('honors a recorded listener port when it is still free', async () => {
    const upstream = await startUpstream();
    const free = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') reject(new Error('probe failed'));
        else probe.close(() => resolve(address.port));
      });
    });

    // Preferring the recorded port is what lets a resumed box keep its URL.
    await expect(startRelay(upstream.port, { DEVBOX_RELAY_LISTEN_PORT: String(free) }))
      .resolves.toBe(free);
  });
});
