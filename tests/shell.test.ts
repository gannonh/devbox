import { describe, it, expect } from 'vitest';
import { RealShellRunner } from '../src/lib/shell.js';

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
});
