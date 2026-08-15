#!/usr/bin/env node
/**
 * Minimal noVNC Basic Auth reverse proxy.
 *
 * The upstream websockify listener is bound to loopback and has no credentials;
 * this process is the only exposed listener.  It handles ordinary HTTP assets
 * and WebSocket upgrade requests so the same auth policy covers vnc.html and
 * the noVNC WebSocket connection.
 */
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const listenHost = process.env.DEVBOX_NOVNC_BIND ?? '0.0.0.0';
const listenPort = Number(process.env.DEVBOX_NOVNC_PORT ?? '6081');
const upstreamHost = process.env.DEVBOX_NOVNC_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.DEVBOX_NOVNC_INTERNAL_PORT ?? '6080');
const username = process.env.DEVBOX_NOVNC_USER ?? 'devbox';
const password = process.env.DEVBOX_NOVNC_PASSWORD;

if (!password) {
  console.error('[devbox-auth-proxy] DEVBOX_NOVNC_PASSWORD is required');
  process.exit(1);
}

const expected = Buffer.from(`${username}:${password}`);

function isAuthorized(request) {
  const value = request.headers.authorization;
  if (!value?.startsWith('Basic ')) return false;

  let supplied;
  try {
    supplied = Buffer.from(value.slice('Basic '.length), 'base64');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function unauthorized(response) {
  response.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Basic realm="devbox noVNC"',
  });
  response.end('Authentication required\n');
}

function stripAuthorization(headers) {
  const forwarded = { ...headers };
  delete forwarded.authorization;
  forwarded.host = `${upstreamHost}:${upstreamPort}`;
  return forwarded;
}

const server = http.createServer((request, response) => {
  if (!isAuthorized(request)) {
    unauthorized(response);
    return;
  }

  const upstream = http.request(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: stripAuthorization(request.headers),
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
});

server.on('upgrade', (request, socket, head) => {
  if (!isAuthorized(request)) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
        'Content-Type: text/plain\r\n' +
        'WWW-Authenticate: Basic realm="devbox noVNC"\r\n' +
        'Connection: close\r\n\r\nAuthentication required\n',
    );
    socket.destroy();
    return;
  }

  const upstream = net.connect(upstreamPort, upstreamHost);
  upstream.once('connect', () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(stripAuthorization(request.headers))) {
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
