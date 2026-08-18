#!/usr/bin/env node
/**
 * Basic-Auth reverse proxy for noVNC.
 *
 * The upstream websockify listener is loopback-only. This process is the only
 * exposed listener and authenticates both HTTP and WebSocket traffic before
 * forwarding it. Credentials never enter a URL, cookie, form, or upstream
 * request header.
 */
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const listenHost = process.env.DEVBOX_NOVNC_BIND ?? '0.0.0.0';
const listenPort = Number(process.env.DEVBOX_NOVNC_PORT ?? '6080');
const upstreamHost = process.env.DEVBOX_NOVNC_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.DEVBOX_NOVNC_INTERNAL_PORT ?? '6081');
const username = 'devbox';
const password = process.env.DEVBOX_NOVNC_PASSWORD;
const realm = 'devbox';

if (!password) {
  console.error('[devbox-auth-proxy] DEVBOX_NOVNC_PASSWORD is required');
  process.exit(1);
}

const expectedUsername = Buffer.from(username);
const expectedPassword = Buffer.from(password);

function matches(value, expected) {
  const supplied = Buffer.from(value ?? '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function basicCredentials(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !/^Basic\s+/i.test(header)) return undefined;
  try {
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return undefined;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function isAuthorized(request) {
  const credentials = basicCredentials(request);
  if (!credentials) return false;
  const usernameMatches = matches(credentials.username, expectedUsername);
  const passwordMatches = matches(credentials.password, expectedPassword);
  return usernameMatches && passwordMatches;
}

function authHeaders() {
  return {
    'www-authenticate': `Basic realm="${realm}"`,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  };
}

function rejectHttp(response) {
  response.writeHead(401, authHeaders());
  response.end('Authentication required\n');
}

function rejectUpgrade(socket) {
  socket.write(
    'HTTP/1.1 401 Unauthorized\r\n'
      + 'WWW-Authenticate: Basic realm="devbox"\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + 'Cache-Control: no-store\r\n'
      + 'Connection: close\r\n\r\n'
      + 'Authentication required\n',
  );
  socket.destroy();
}

function stripHttpHeaders(headers) {
  const forwarded = { ...headers };
  for (const name of [
    'authorization',
    'connection',
    'cookie',
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
  delete forwarded.cookie;
  delete forwarded['proxy-authenticate'];
  delete forwarded['proxy-authorization'];
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
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
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
  if (!isAuthorized(request)) {
    rejectHttp(response);
    return;
  }
  proxyHttp(request, response);
});

server.on('upgrade', (request, socket, head) => {
  if (!isAuthorized(request)) {
    rejectUpgrade(socket);
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
    // The upstream returns the 101 Switching Protocols response through this tunnel.
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
