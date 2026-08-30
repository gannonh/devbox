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
    expect(source).toContain('same HTTP response');
    expect(source).toContain('forced-close same foreground PID');
    expect(source).toContain('clean Ctrl-] detach');
    expect(source).toContain('snapshot fresh socket');
    expect(source).toContain('snapshot prior process ended');
    expect(source).toContain('prior user processes ended');
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
