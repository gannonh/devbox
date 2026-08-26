import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const dockerfilePath = 'images/vercel/Dockerfile';
const startupPath = 'images/vercel/start-devbox.sh';
const statusPath = 'images/vercel/status-devbox.sh';
const proxyPath = 'images/vercel/novnc-proxy.mjs';
const localCheckPath = 'images/vercel/check-local-image.sh';
const relayPath = 'images/vercel/app-relay.mjs';
const relayControlPath = 'images/vercel/app-relay-control.sh';

async function text(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

describe('Vercel image assets', () => {
  it('uses a digest-pinned Ubuntu mirror and leaves runtime startup explicit', async () => {
    const dockerfile = await text(dockerfilePath);
    expect(dockerfile).toMatch(
      /FROM docker\.io\/library\/ubuntu:26\.04@sha256:[a-f0-9]{64} AS ubuntu-base/,
    );
    expect(dockerfile).not.toContain('vcr.vercel.com/vercel/sandbox/universal');
    expect(dockerfile).not.toContain('UNIVERSAL_BASE_DIGEST');
    expect(dockerfile).not.toMatch(/^\s*ENTRYPOINT\b/m);
    expect(dockerfile.match(/^\s*CMD\b.*$/gm)).toEqual(['CMD []']);
    expect(dockerfile).toContain('USER ubuntu');
    expect(dockerfile).toContain('ENV HOME=/vercel');
    expect(dockerfile).toContain('xvfb');
    expect(dockerfile).toContain('fluxbox');
    expect(dockerfile).toContain('x11vnc');
    expect(dockerfile).toContain('novnc');
    expect(dockerfile).toContain('chromium');
    expect(dockerfile).toContain('libgbm1');
    expect(dockerfile).toContain('libgtk-3-0t64');
    expect(dockerfile).not.toMatch(/(VERCEL_TOKEN|GH_TOKEN|PASSWORD=|SECRET=|COPY .*\\.env)/i);
  });

  it('uses a reviewed dated Ubuntu package snapshot for reproducible apt inputs', async () => {
    const dockerfile = await text(dockerfilePath);
    expect(dockerfile).toContain('UBUNTU_SNAPSHOT=');
    expect(dockerfile).toContain('snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}');
    expect(dockerfile).toContain('check-valid-until=no');
    expect(dockerfile).toContain('VERSION_CODENAME');
    expect(dockerfile).toContain('rm -f /etc/apt/sources.list');
    expect(dockerfile).not.toMatch(/apt-get update[\\s\\S]*archive\\.ubuntu\\.com/);
  });

  it('ships explicit startup, status, and local image checks', async () => {
    const startup = await text(startupPath);
    const status = await text(statusPath);
    const localCheck = await text(localCheckPath);
    expect(startup).toContain('novnc-proxy.mjs');
    expect(startup).toContain('x11vnc');
    expect(startup).toContain('websockify');
    expect(startup).toContain('127.0.0.1:${NOVNC_INTERNAL_PORT}');
    expect(startup).toContain('DEVBOX_NOVNC_PASSWORD');
    expect(startup).toContain('proc_start_time');
    expect(startup).toContain('recorded');
    expect(status).toContain('sudo -n true');
    expect(status).toContain("'Xvfb -help'");
    expect(status).toContain("'websockify --help'");
    expect(status).toContain('exit "${failed}"');
    expect(status).toContain('%s=running');
    expect(status).toContain('%s=stopped');
    for (const process of ['Xvfb', 'fluxbox', 'x11vnc', 'websockify', 'auth-proxy']) {
      expect(status).toContain(process);
    }
    // The liveness probe must pgrep the filename actually shipped and launched,
    // or it reports a running proxy as stopped.
    const proxyFile = proxyPath.split('/').at(-1) as string;
    expect(status).toContain(`[${proxyFile[0]}]${proxyFile.slice(1)}`);
    expect(startup).toContain(proxyFile);
    expect(await text(dockerfilePath)).toContain(proxyFile);
    expect(status).toContain('pi');
    expect(status).toContain('claude');
    expect(status).toContain('codex');
    expect(status).toContain('opencode');
    expect(localCheck).toContain('Config.Entrypoint');
    expect(localCheck).toContain('Config.Cmd');
    expect(localCheck).toContain('sudo -n true');
  });

  it('pairs an access code into a cookie for HTTP and WebSocket traffic', async () => {
    const proxy = await text(proxyPath);
    expect(proxy).toContain("const COOKIE = 'devbox_novnc'");
    expect(proxy).toContain('pairingForm');
    expect(proxy).toContain('HttpOnly; Secure; SameSite=Lax');
    // Pairing must consume the code and redirect it out of the address bar.
    expect(proxy).toContain("searchParams.delete('token')");
    expect(proxy).toContain('303');
    expect(proxy).toContain("server.on('upgrade',");
    expect(proxy).toContain('101 Switching Protocols');
    expect(proxy).toContain('timingSafeEqual');
    // The credential never reaches websockify on either transport.
    expect(proxy).toContain("delete forwarded['proxy-authorization']");
    expect(proxy).toContain("delete forwarded['proxy-authenticate']");
    expect(proxy).toContain('delete forwarded.cookie');
    expect(proxy).not.toContain('www-authenticate');
  });

  it('ships an app relay with a fixed target and no credential of its own', async () => {
    const relay = await text(relayPath);
    const control = await text(relayControlPath);

    // The upstream comes from the environment at startup and from nowhere else.
    expect(relay).toContain('DEVBOX_RELAY_TARGET_PORT');
    expect(relay).toContain('const upstreamHost = \'localhost\'');
    expect(relay).toContain('autoSelectFamily: true');
    expect(relay).toContain('127.0.0.1');
    expect(relay).toContain('::1');
    expect(relay).toContain('RESERVED_PORTS = new Set([5900, 6080, 6081])');
    expect(relay).toContain('reserved display port');
    // Host is rewritten; Origin and credentials are not touched.
    expect(relay).toContain('headers.host = upstreamAuthority');
    expect(relay).toContain("headers['x-forwarded-proto'] = 'https'");
    expect(relay).not.toMatch(/delete .*\.origin\b/);
    expect(relay).not.toContain('DEVBOX_NOVNC_PASSWORD');
    // A pre-listen route must answer, not hang, and must not loop.
    expect(relay).toContain('UPSTREAM_CONNECT_TIMEOUT_MS');
    expect(relay).toContain('502');
    expect(relay).toContain("server.on('upgrade',");

    // The control script is the PID/start-time evidence the manager trusts.
    expect(control).toContain('proc_start_time');
    expect(control).toContain('process_matches');
    expect(control).toContain('app-relay.mjs');
    expect(control).toContain('env -u DEVBOX_NOVNC_PASSWORD');
  });
});
