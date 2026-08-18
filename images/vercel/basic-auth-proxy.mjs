#!/usr/bin/env node
/**
 * Token pairing reverse proxy for noVNC.
 *
 * The upstream websockify listener is bound to loopback and has no credentials;
 * this process is the only exposed listener. A valid `token` query param, cookie,
 * or form POST pairs the browser; later requests (including WebSocket upgrades)
 * use the cookie.
 */
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const listenHost = process.env.DEVBOX_NOVNC_BIND ?? '0.0.0.0';
const listenPort = Number(process.env.DEVBOX_NOVNC_PORT ?? '6081');
const upstreamHost = process.env.DEVBOX_NOVNC_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.DEVBOX_NOVNC_INTERNAL_PORT ?? '6080');
const token = process.env.DEVBOX_NOVNC_PASSWORD;
const COOKIE = 'devbox_novnc';

if (!token) {
  console.error('[devbox-auth-proxy] DEVBOX_NOVNC_PASSWORD is required');
  process.exit(1);
}

const expected = Buffer.from(token);

function matchesToken(value) {
  if (!value) return false;
  const supplied = Buffer.from(value);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function queryToken(url) {
  return new URL(url, 'http://devbox').searchParams.get('token') ?? undefined;
}

function cookieToken(header) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
}

function isAuthorized(request, bodyToken) {
  return matchesToken(queryToken(request.url ?? '/'))
    || matchesToken(cookieToken(request.headers.cookie))
    || matchesToken(bodyToken);
}

function cookieHeader() {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
}

function withCookie(headers) {
  const forwarded = { ...headers };
  const existing = forwarded['set-cookie'];
  forwarded['set-cookie'] = existing
    ? [...(Array.isArray(existing) ? existing : [existing]), cookieHeader()]
    : cookieHeader();
  return forwarded;
}

function pairingForm() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>devbox display</title>
  <style>
    body { font: 16px system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    form { display: flex; gap: 0.5rem; }
    input, button { font: inherit; padding: 0.4rem 0.6rem; }
  </style>
</head>
<body>
  <form method="post" action="/">
    <input name="token" type="text" autocomplete="one-time-code" placeholder="Access code" autofocus>
    <button type="submit">Open display</button>
  </form>
</body>
</html>
`;
}

function showForm(response) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(pairingForm());
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function stripHttpHeaders(headers) {
  const forwarded = { ...headers };
  for (const name of [
    'authorization',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) delete forwarded[name];
  forwarded.host = `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

function stripWebSocketHeaders(headers) {
  const forwarded = { ...headers };
  delete forwarded.authorization;
  forwarded.host = `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

function proxyHttp(request, response) {
  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      agent: false,
      headers: stripHttpHeaders(request.headers),
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, withCookie(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    },
  );

  upstream.on('error', (error) => {
    console.error(`[devbox-auth-proxy] upstream HTTP error: ${error.message}`);
    if (!response.headersSent) response.writeHead(502);
    response.end('noVNC upstream unavailable\n');
  });
  request.pipe(upstream);
}

const server = http.createServer((request, response) => {
  void (async () => {
    let bodyToken;
    if (request.method === 'POST') {
      bodyToken = new URLSearchParams(await readBody(request)).get('token') ?? undefined;
    }
    if (!isAuthorized(request, bodyToken)) {
      showForm(response);
      return;
    }
    if (request.method === 'POST') {
      response.writeHead(303, {
        location: '/vnc.html?autoconnect=1',
        'set-cookie': cookieHeader(),
      });
      response.end();
      return;
    }
    proxyHttp(request, response);
  })().catch((error) => {
    console.error(`[devbox-auth-proxy] request error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.on('upgrade', (request, socket, head) => {
  if (!isAuthorized(request)) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n'
        + 'Content-Type: text/plain\r\n'
        + 'Connection: close\r\n\r\nAuthentication required\n',
    );
    socket.destroy();
    return;
  }

  const upstream = net.connect(upstreamPort, upstreamHost);
  upstream.once('connect', () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(stripWebSocketHeaders(request.headers))) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
    // websockify returns the 101 Switching Protocols response through this
    // byte-for-byte tunnel after the authenticated request is forwarded.
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', (error) => {
    console.error(`[devbox-auth-proxy] upstream WebSocket error: ${error.message}`);
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
});

server.listen(listenPort, listenHost, () => {
  console.error(`[devbox-auth-proxy] listening on ${listenHost}:${listenPort}`);
});
