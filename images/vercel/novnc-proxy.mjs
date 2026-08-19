#!/usr/bin/env node
/**
 * Access-code pairing reverse proxy for noVNC.
 *
 * The upstream websockify listener is loopback-only; this process is the only
 * exposed listener and authenticates both HTTP and WebSocket traffic before
 * forwarding it.
 *
 * A browser pairs by presenting the branch access code once — as the `token`
 * query parameter on the printed display link, or by typing it into the form
 * shown to unpaired clients. A valid code is exchanged for an HttpOnly cookie
 * and immediately redirected away, so the code does not stay in the address
 * bar, in history, or in a Referer header. Later requests, including the
 * WebSocket upgrade, carry only the cookie. The code and cookie are never
 * forwarded upstream.
 *
 * This pairing flow is the intended design: it is what makes the printed
 * display link work on click. It has been replaced with Basic Auth once
 * already, by a reader who trusted this file's old name over its contents.
 * See docs/adrs/0003-novnc-access-code-pairing.md before changing it.
 */
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const listenHost = process.env.DEVBOX_NOVNC_BIND ?? '0.0.0.0';
const listenPort = Number(process.env.DEVBOX_NOVNC_PORT ?? '6080');
const upstreamHost = process.env.DEVBOX_NOVNC_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.DEVBOX_NOVNC_INTERNAL_PORT ?? '6081');
const code = process.env.DEVBOX_NOVNC_PASSWORD;
const COOKIE = 'devbox_novnc';
const VIEWER = '/vnc.html?autoconnect=1';

if (!code) {
  console.error('[devbox-auth-proxy] DEVBOX_NOVNC_PASSWORD is required');
  process.exit(1);
}

const expected = Buffer.from(code);

function matches(value) {
  const supplied = Buffer.from(value ?? '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requestUrl(request) {
  return new URL(request.url ?? '/', 'http://devbox');
}

function cookieCode(header) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name.trim() === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function isPaired(request) {
  return matches(cookieCode(request.headers.cookie));
}

function cookieHeader() {
  return `${COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// Pairing consumes the code and sends the browser to a URL without it, so the
// secret never persists in the address bar or leaks through a Referer header.
function pairAndRedirect(response, location) {
  response.writeHead(303, {
    location,
    'set-cookie': cookieHeader(),
    'cache-control': 'no-store',
  });
  response.end();
}

function pairingForm(invalid) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>devbox display</title>
  <style>
    body { font: 16px system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    form { display: flex; flex-direction: column; gap: 0.75rem; width: min(22rem, 90vw); }
    input, button { font: inherit; padding: 0.5rem 0.6rem; }
    p { margin: 0; color: #b00; }
  </style>
</head>
<body>
  <form method="post" action="/">
    <label for="token">Access code</label>
    <input id="token" name="token" type="password" autocomplete="one-time-code" autofocus>
    ${invalid ? '<p>That code was not accepted.</p>' : ''}
    <button type="submit">Open display</button>
  </form>
</body>
</html>
`;
}

function showForm(response, invalid = false) {
  response.writeHead(invalid ? 401 : 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  response.end(pairingForm(invalid));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      // A pairing form post is tiny; refuse to buffer anything larger.
      if (size > 4096) {
        reject(new Error('pairing body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
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
  void (async () => {
    if (request.method === 'POST') {
      const submitted = new URLSearchParams(await readBody(request)).get('token');
      if (matches(submitted)) {
        pairAndRedirect(response, VIEWER);
      } else {
        showForm(response, true);
      }
      return;
    }

    const url = requestUrl(request);
    const supplied = url.searchParams.get('token');
    if (supplied !== null) {
      if (!matches(supplied)) {
        showForm(response, true);
        return;
      }
      url.searchParams.delete('token');
      pairAndRedirect(response, `${url.pathname}${url.search}`);
      return;
    }

    if (!isPaired(request)) {
      showForm(response);
      return;
    }
    proxyHttp(request, response);
  })().catch((error) => {
    console.error(`[devbox-auth-proxy] request error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

// The upgrade carries no body, so it pairs by cookie or by a code still on the
// WebSocket URL; there is no form fallback on this path.
server.on('upgrade', (request, socket, head) => {
  const supplied = requestUrl(request).searchParams.get('token');
  if (!isPaired(request) && !matches(supplied)) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n'
        + 'Content-Type: text/plain; charset=utf-8\r\n'
        + 'Cache-Control: no-store\r\n'
        + 'Connection: close\r\n\r\n'
        + 'Display pairing required\n',
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
