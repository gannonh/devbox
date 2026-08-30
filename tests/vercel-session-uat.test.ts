import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('public Vercel session UAT driver', () => {
  it('drives the built CLI through a PTY for both duration and reconnect paths', async () => {
    const source = await readFile('scripts/vercel/session-uat.mjs', 'utf8');

    expect(source).toContain("spawn('script'");
    expect(source).toContain("process.execPath");
    expect(source).toContain("'--provider',");
    expect(source).toContain("'--expose-ports',");
    expect(source).toContain("'--attach'");
    expect(source).toContain("'--timeout'");
    expect(source).toContain("close('SIGKILL')");
    expect(source).toContain('remoteHttpFixtureCommand');
    expect(source).toContain('waitForFixture');
    expect(source).toContain('readProviderSessionFacts');
    expect(source).toContain('configuredTimeoutMs');
    expect(source).toContain('createdAt');
    expect(source).toContain('expiresAt');
    expect(source).toContain('waitForProviderStop');
    expect(source).toContain('one retained snapshot');
    expect(source).toContain('duration idle provider session');
    expect(source).toContain('duration final provider session');
    expect(source).toContain('parseDetachedProcessStartup');
    expect(source).toContain('kill -0');
    expect(source).toContain('DURATION_IDLE_BOUNDARY_MS');
    expect(source).toContain('DURATION_FINAL_WINDOW_MS');
    expect(source).toContain('same HTTP response');
    expect(source).toContain('forced-close same foreground PID');
    expect(source).toContain('clean Ctrl-] detach');
    expect(source).toContain('snapshot fresh socket');
    expect(source).toContain('snapshot prior process ended');
    expect(source).toContain('prior user processes ended');
    expect(source).toContain('snapshot display route returned');
  });

  it('writes redacted evidence and has an explicit cleanup mode', async () => {
    const source = await readFile('scripts/vercel/session-uat.mjs', 'utf8');

    expect(source).toContain('redacted: true');
    expect(source).toContain("process.argv[2] === '--cleanup'");
    expect(source).toContain('XDG_STATE_HOME');
    expect(source).toContain('DEVBOX_UAT_REPORT');
    expect(source).toContain('runCleanup(stateHome)');
    expect(source).toContain('mode: MODE');
  });
});
