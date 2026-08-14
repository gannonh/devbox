import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const dockerfilePath = 'images/vercel/Dockerfile';
const startupPath = 'images/vercel/start-devbox.sh';
const statusPath = 'images/vercel/status-devbox.sh';
const proxyPath = 'images/vercel/basic-auth-proxy.mjs';
const localCheckPath = 'images/vercel/check-local-image.sh';

async function text(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

describe('Vercel image assets', () => {
  it('uses a digest-pinned Universal base and leaves runtime startup explicit', async () => {
    const dockerfile = await text(dockerfilePath);
    expect(dockerfile).toMatch(
      /FROM vcr\.vercel\.com\/vercel\/sandbox\/universal@sha256:\$\{UNIVERSAL_BASE_DIGEST\}/,
    );
    expect(dockerfile).not.toMatch(/^\s*(ENTRYPOINT|CMD)\b/m);
    expect(dockerfile).toContain('USER ubuntu');
    expect(dockerfile).toContain('xvfb');
    expect(dockerfile).toContain('fluxbox');
    expect(dockerfile).toContain('x11vnc');
    expect(dockerfile).toContain('novnc');
    expect(dockerfile).toContain('chromium');
    expect(dockerfile).not.toMatch(/(VERCEL_TOKEN|GH_TOKEN|PASSWORD=|SECRET=|COPY .*\\.env)/i);
  });

  it('ships explicit startup, status, and local image checks', async () => {
    const startup = await text(startupPath);
    const status = await text(statusPath);
    const localCheck = await text(localCheckPath);
    expect(startup).toContain('basic-auth-proxy.mjs');
    expect(startup).toContain('x11vnc');
    expect(startup).toContain('websockify');
    expect(startup).toContain('DEVBOX_NOVNC_PASSWORD');
    expect(status).toContain('sudo -n true');
    expect(status).toContain('exit "${failed}"');
    expect(status).toContain('%s=running');
    expect(status).toContain('%s=stopped');
    for (const process of ['Xvfb', 'fluxbox', 'x11vnc', 'websockify', 'auth-proxy']) {
      expect(status).toContain(process);
    }
    expect(status).toContain('pi');
    expect(status).toContain('claude');
    expect(status).toContain('codex');
    expect(status).toContain('opencode');
    expect(localCheck).toContain('Config.Entrypoint');
    expect(localCheck).toContain('Config.Cmd');
    expect(localCheck).toContain('sudo -n true');
  });

  it('supports Basic Auth for both HTTP and WebSocket noVNC traffic', async () => {
    const proxy = await text(proxyPath);
    expect(proxy).toContain('authorization');
    expect(proxy).toContain('upgrade');
    expect(proxy).toContain('101 Switching Protocols');
    expect(proxy).toContain('timingSafeEqual');
  });
});
