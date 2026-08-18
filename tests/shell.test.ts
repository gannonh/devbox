import { describe, it, expect } from 'vitest';
import { RealShellRunner, escapeShellSingleQuote, commandExists } from '../src/lib/shell.js';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a child to report readiness instead of guessing with a fixed sleep.
 * A spawned `node -e` process can take arbitrarily long to boot and install its
 * SIGINT handler on a loaded machine; signalling before that happens kills the
 * child with the default action and fails the assertion spuriously.
 */
async function waitUntil(ready: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the child to become ready');
    await sleep(10);
  }
}

describe('RealShellRunner.spawnInherit', () => {
  it('spawns a child with inherited stdio and resolves with its exit code', async () => {
    const runner = new RealShellRunner();
    // Use a trivial command that exits 0
    const code = await runner.spawnInherit('true', []);
    expect(code).toBe(0);
  });

  it('resolves with non-zero exit code when the child fails', async () => {
    const runner = new RealShellRunner();
    const code = await runner.spawnInherit('false', []);
    expect(code).toBe(1);
  });
});

describe('RealShellRunner.spawnInherit signal forwarding', () => {
  // This test verifies that a child process responds to kill('SIGINT') — i.e.,
  // that Node's child.kill delivers signals. It does NOT exercise
  // spawnInherit's own parent-to-child forwarding path (the onSignal handler);
  // the test below ("forwards SIGINT from the parent to the child") covers
  // that via a dependency-injected signal source.
  it('a child process responds to kill("SIGINT")', async () => {
    const childScript = `
      process.on('SIGINT', () => {
        process.stdout.write('GOT_SIGINT\\n');
        process.exit(42);
      });
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn('node', ['-e', childScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let childOut = '';
    child.stdout?.on('data', (d: Buffer) => (childOut += d.toString()));

    await waitUntil(() => childOut.includes('READY'));

    child.kill('SIGINT');

    const code = await new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? 0));
    });

    expect(code).toBe(42);
    expect(childOut).toContain('GOT_SIGINT');
  });

  it('forwards SIGINT from the parent to the child', async () => {
    // Exercise spawnInherit's parent-to-child forwarding path: the onSignal
    // handler registered on signalSource must call child.kill(signal) when a
    // signal is emitted on the signalSource. We inject a fake EventEmitter so
    // we can emit 'SIGINT' without killing the vitest process.
    const signalSource = new EventEmitter();
    const runner = new RealShellRunner();

    // stdio is inherited here, so the child reports readiness through a marker
    // file rather than a pipe the test could read.
    const readyFile = join(await mkdtemp(join(tmpdir(), 'devbox-signal-')), 'ready');
    const childScript = `
      process.on('SIGINT', () => {
        process.stdout.write('GOT_SIGINT\\n');
        process.exit(42);
      });
      require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');
      setInterval(() => {}, 1000);
    `;

    // spawnInherit uses inherited stdio; the fake signalSource is the 4th arg.
    // The child writes 'GOT_SIGINT' to its stdout (inherited to our stdout)
    // and exits 42 on SIGINT. We assert on the exit code — if the forwarding
    // path is broken, the child never receives the signal and the test times
    // out.
    const exitPromise = runner.spawnInherit(
      'node',
      ['-e', childScript],
      {},
      signalSource,
    );

    // Wait until the child has actually installed its handler.
    await waitUntil(() => existsSync(readyFile));

    // Emit SIGINT on the fake signal source — this exercises the onSignal
    // handler in spawnInherit, which must forward to child.kill('SIGINT').
    // If the handler is missing or broken, the child hangs and times out.
    signalSource.emit('SIGINT', 'SIGINT');

    const code = await exitPromise;
    expect(code).toBe(42);
  });
});

describe('RealShellRunner.exec', () => {
  it('returns trimmed stdout on success', async () => {
    const runner = new RealShellRunner();
    const result = await runner.exec('echo', ['hello']);
    expect(result).toBe('hello');
  });

  it('throws on non-zero exit', async () => {
    const runner = new RealShellRunner();
    await expect(runner.exec('false', [])).rejects.toThrow();
  });
});

describe('RealShellRunner.execQuiet', () => {
  it('returns stdout and code without throwing', async () => {
    const runner = new RealShellRunner();
    const result = await runner.execQuiet('echo', ['test'], { silentStderr: true });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('test');
  });

  it('returns non-zero code without throwing', async () => {
    const runner = new RealShellRunner();
    const result = await runner.execQuiet('false', [], { silentStderr: true });
    expect(result.code).toBe(1);
  });

  it('returns a stable non-zero code when the executable is missing', async () => {
    const runner = new RealShellRunner();
    const result = await runner.execQuiet('/definitely/missing/devbox-command', [], { silentStderr: true });
    expect(result).toEqual({ stdout: '', code: 127 });
  });

  it('routes child stderr to the caller-provided stream', async () => {
    const runner = new RealShellRunner();
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk) => { output += chunk.toString(); });

    await runner.execQuiet(process.execPath, ['-e', "process.stderr.write('child stderr')"], { stderr });

    expect(output).toBe('child stderr');
  });
});

describe('escapeShellSingleQuote', () => {
  it('wraps a plain token in single quotes', () => {
    expect(escapeShellSingleQuote('ghp_abcd1234')).toBe("'ghp_abcd1234'");
  });

  it('escapes single quotes by closing, escaping, and reopening', () => {
    // ab'cd -> 'ab'\''cd'  (close quote, \' escaped quote, reopen quote)
    const expected = "'ab'\\''cd'";
    expect(escapeShellSingleQuote("ab'cd")).toBe(expected);
  });

  it('handles a token with multiple single quotes', () => {
    // a'b'c -> 'a'\''b'\''c'
    const expected = "'a'\\''b'\\''c'";
    expect(escapeShellSingleQuote("a'b'c")).toBe(expected);
  });

  it('handles empty string', () => {
    expect(escapeShellSingleQuote('')).toBe("''");
  });
});

describe('commandExists', () => {
  it('returns true for a command that exists (node)', async () => {
    expect(await commandExists('node')).toBe(true);
  });

  it('returns true for a command that exists (true)', async () => {
    expect(await commandExists('true')).toBe(true);
  });

  it('returns false for a command that does not exist', async () => {
    expect(await commandExists('definitely-not-a-real-command-xyz')).toBe(false);
  });
});
