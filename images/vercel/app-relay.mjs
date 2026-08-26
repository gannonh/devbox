#!/usr/bin/env node
/**
 * Fixed-target HTTP/WebSocket relay for one public Vercel app route.
 *
 * A Vercel Sandbox route needs an externally reachable listener, and an
 * ordinary dev command binds loopback and checks the Host header it is given
 * (Vite refuses an unknown one unless the project sets `server.allowedHosts`).
 * This process is the exposed listener: it accepts the public route's traffic
 * and replays it to `localhost:<logical port>` so the app sees the request it
 * would see from a local browser, with no project edit and no `--host` flag.
 *
 * The upstream is fixed at startup from the environment. Nothing in a request
 * can select or override it -- there is no proxy mode here, only this one
 * mapping -- and the display ports are refused outright, so a relay can never
 * become a path to the private VNC stack.
 *
 * Read docs/adrs/0007-relay-backed-public-app-routes.md before changing the
 * header contract: Host is deliberately rewritten, Origin deliberately is not.
 */
import http from 'node:http';
import net from 'node:net';
import { writeFileSync, renameSync } from 'node:fs';

/** Display ports that must never be a relay target or a relay listener. */
const RESERVED_PORTS = new Set([5900, 6080, 6081]);
/** Bound the pre-listen failure so a public URL answers instead of hanging. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 2_000;
/** Generic, bounded, and free of internal paths: the body a stranger may see. */
const UNAVAILABLE_BODY = 'devbox relay: the app is not listening on this port yet\n';
const BAD_REQUEST_BODY = 'devbox relay: malformed request authority\n';
/** Kernel-allocated ports that collide with a reservation are retried, not used. */
const BIND_ATTEMPTS = 16;

/**
 * Hop-by-hop headers, per RFC 7230 6.1.
 *
 * `Trailer` is deliberately absent: it is end-to-end and names the fields the
 * trailer section carries, which the response contract has to preserve.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'transfer-encoding',
  'upgrade',
]);

const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/;

const targetPort = parsePort(process.env.DEVBOX_RELAY_TARGET_PORT, 'DEVBOX_RELAY_TARGET_PORT');
const preferredPort = process.env.DEVBOX_RELAY_LISTEN_PORT === undefined
  || process.env.DEVBOX_RELAY_LISTEN_PORT === ''
  ? 0
  : parsePort(process.env.DEVBOX_RELAY_LISTEN_PORT, 'DEVBOX_RELAY_LISTEN_PORT');
const forbiddenPorts = parseForbidden(process.env.DEVBOX_RELAY_FORBIDDEN_PORTS);
const statePath = process.env.DEVBOX_RELAY_STATE_PATH;
const listenHost = process.env.DEVBOX_RELAY_BIND ?? '0.0.0.0';
const upstreamHost = '127.0.0.1';
const upstreamAuthority = `localhost:${targetPort}`;

if (RESERVED_PORTS.has(targetPort)) {
  fail(`DEVBOX_RELAY_TARGET_PORT ${targetPort} is a reserved display port`);
}
forbiddenPorts.add(targetPort);
for (const reserved of RESERVED_PORTS) forbiddenPorts.add(reserved);

function fail(message) {
  console.error(`[devbox-relay] ${message}`);
  process.exit(1);
}

function parsePort(value, label) {
  if (!/^(?:0|[1-9]\d*)$/.test(value ?? '')) fail(`${label} must be a decimal port`);
  const port = Number(value);
  if (port < 1 || port > 65_535) fail(`${label} must be in 1..65535`);
  return port;
}

function parseForbidden(value) {
  const ports = new Set();
  for (const entry of (value ?? '').split(',')) {
    const token = entry.trim();
    if (token === '') continue;
    if (!/^(?:0|[1-9]\d*)$/.test(token)) fail('DEVBOX_RELAY_FORBIDDEN_PORTS must be decimal ports');
    ports.add(Number(token));
  }
  return ports;
}

/** The incoming authority, when it is one at all. Anything else is a 400. */
function validAuthority(request) {
  const host = request.headers.host;
  if (typeof host !== 'string') return undefined;
  const match = HOST_PATTERN.exec(host);
  if (!match) return undefined;
  if (match[1] !== undefined && Number(match[1]) > 65_535) return undefined;
  return host;
}

function peerAddress(socket) {
  const address = socket.remoteAddress ?? '';
  // A v4-mapped v6 peer is the same client; record the address it dialed from.
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/** Header names a `Connection:` token marks hop-by-hop for this message only. */
function connectionTokens(value) {
  const tokens = new Set();
  const raw = Array.isArray(value) ? value.join(',') : value ?? '';
  for (const token of raw.split(',')) {
    const name = token.trim().toLowerCase();
    if (name !== '') tokens.add(name);
  }
  return tokens;
}

/**
 * Build the upstream header set for a request.
 *
 * `Origin` and application credentials survive untouched -- the app's own
 * origin policy stays the app's decision. Only the transport-level fields are
 * replaced: Host becomes the fixed local target, and every client-supplied
 * `Forwarded`/`X-Forwarded-*` value is dropped before this relay states what
 * it actually observed.
 */
function upstreamHeaders(request, authority, { keepUpgrade = false } = {}) {
  const dropped = connectionTokens(request.headers.connection);
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'host') continue;
    if (lower === 'forwarded' || lower.startsWith('x-forwarded-')) continue;
    if (keepUpgrade && (lower === 'upgrade' || lower === 'connection')) continue;
    if (HOP_BY_HOP.has(lower) || dropped.has(lower)) continue;
    headers[lower] = value;
  }
  headers.host = upstreamAuthority;
  headers['x-forwarded-host'] = authority;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = peerAddress(request.socket);
  return headers;
}

/** Strip the response's hop-by-hop fields; everything else is end-to-end. */
function downstreamHeaders(upstreamResponse) {
  const dropped = connectionTokens(upstreamResponse.headers.connection);
  const headers = {};
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || dropped.has(lower)) continue;
    headers[lower] = value;
  }
  return headers;
}

function respondPlain(response, status, body) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const authority = validAuthority(request);
  // Origin-form only. An absolute-form target is how a client asks a proxy to
  // pick a destination, and this relay does not have one to pick.
  if (authority === undefined || !(request.url ?? '').startsWith('/')) {
    respondPlain(response, 400, BAD_REQUEST_BODY);
    return;
  }

  const upstream = http.request({
    host: upstreamHost,
    port: targetPort,
    method: request.method,
    path: request.url,
    agent: false,
    headers: upstreamHeaders(request, authority),
  });

  // ClientRequest.setTimeout is a socket inactivity timer, not a connect-only
  // deadline. Bound the wait until TCP connects, then clear it: a cold Vite or
  // Next compile can take longer than this to emit headers, and a streaming
  // response must not be killed mid-flight. Matches the WebSocket path below.
  upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
    upstream.destroy(new Error('upstream connect timeout'));
  });
  upstream.on('socket', (socket) => {
    socket.once('connect', () => {
      upstream.setTimeout(0);
    });
  });

  let settled = false;
  upstream.on('response', (upstreamResponse) => {
    settled = true;
    upstream.setTimeout(0);
    upstreamResponse.socket?.setTimeout(0);
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      downstreamHeaders(upstreamResponse),
    );
    // Registered before pipe(), whose own end handler closes the response.
    upstreamResponse.on('end', () => {
      const trailers = upstreamResponse.trailers ?? {};
      if (Object.keys(trailers).length > 0) response.addTrailers(trailers);
    });
    upstreamResponse.pipe(response);
    response.on('close', () => upstreamResponse.destroy());
  });

  // One attempt, no retry loop: a pre-listen route answers immediately and
  // says nothing about this Sandbox beyond "not yet".
  upstream.on('error', () => {
    if (settled) {
      response.destroy();
      return;
    }
    respondPlain(response, 502, UNAVAILABLE_BODY);
  });

  request.on('error', () => upstream.destroy());
  request.pipe(upstream);
});

// The upgrade tunnel rebuilds only the hop-by-hop fields the handshake needs;
// subprotocol negotiation, application headers, and credentials pass through.
server.on('upgrade', (request, socket, head) => {
  const authority = validAuthority(request);
  if (authority === undefined || !(request.url ?? '').startsWith('/')) {
    socket.end(
      'HTTP/1.1 400 Bad Request\r\n'
      + 'content-type: text/plain; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(BAD_REQUEST_BODY)}\r\n`
      + 'connection: close\r\n\r\n'
      + BAD_REQUEST_BODY,
    );
    return;
  }

  const upstream = net.connect(targetPort, upstreamHost);
  upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
    upstream.destroy(new Error('upstream connect timeout'));
  });
  upstream.once('connect', () => {
    upstream.setTimeout(0);
    const headers = upstreamHeaders(request, authority, { keepUpgrade: true });
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    lines.push(`upgrade: ${request.headers.upgrade}`);
    lines.push('connection: Upgrade');
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    // The upstream's own 101 travels back through this tunnel unmodified.
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  // A failed upgrade closes the client connection. It never re-dials: a second
  // upstream connection per handshake is how a relay becomes an amplifier.
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

function publish(relayPort) {
  if (statePath !== undefined && statePath !== '') {
    const pending = `${statePath}.pending`;
    writeFileSync(
      pending,
      `${JSON.stringify({ logicalPort: targetPort, relayPort, pid: process.pid })}\n`,
      { mode: 0o600 },
    );
    // Renamed into place so a reader never sees a half-written mapping.
    renameSync(pending, statePath);
  }
  console.error(`[devbox-relay] listening ${relayPort} -> ${upstreamAuthority}`);
}

/**
 * Bind, then check what the kernel handed back.
 *
 * Port 0 can return a logical app port that nothing has bound yet -- the dev
 * server that is about to want 5173 is exactly the process that has not
 * started. Refuse those and try again rather than stealing the app's port.
 */
function bind(attempt, port) {
  const onListening = () => {
    server.removeListener('error', onError);
    const address = server.address();
    const chosen = typeof address === 'object' && address !== null ? address.port : 0;
    if (!forbiddenPorts.has(chosen)) {
      server.on('error', (error) => console.error(`[devbox-relay] listener error: ${error.code ?? 'unknown'}`));
      publish(chosen);
      return;
    }
    if (attempt >= BIND_ATTEMPTS) {
      fail(`no acceptable listener port after ${BIND_ATTEMPTS} attempts`);
    }
    server.close(() => bind(attempt + 1, 0));
  };
  const onError = (error) => {
    server.removeListener('listening', onListening);
    if (attempt >= BIND_ATTEMPTS) fail(`listener bind failed: ${error.code ?? 'unknown'}`);
    // A recorded port that something else now owns falls back to a fresh one.
    bind(attempt + 1, 0);
  };
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(port, listenHost);
}

bind(1, forbiddenPorts.has(preferredPort) ? 0 : preferredPort);
