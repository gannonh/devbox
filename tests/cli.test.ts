import { describe, it, expect } from 'vitest';
import { dispatch } from '../src/cli.js';
import { PassThrough } from 'node:stream';

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d.toString()));
  stderr.on('data', (d) => (err += d.toString()));
  const code = dispatch(args, { stdout, stderr });
  return { code, stdout: out, stderr: err };
}

describe('cli dispatch', () => {
  it('--help prints usage with command list and exits 0', () => {
    const { code, stdout, stderr } = run(['--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('devbox');
    expect(output).toContain('init');
    expect(output).toContain('--attach');
    expect(output).toContain('--stop');
    expect(output).toContain('--rm');
    expect(output).toContain('--list');
    expect(output).toContain('--url');
  });

  it('-h alias also prints help and exits 0', () => {
    const { code } = run(['-h']);
    expect(code).toBe(0);
  });

  it('no args prints usage and exits non-zero', () => {
    const { code, stdout, stderr } = run([]);
    const output = stdout + stderr;
    expect(code).not.toBe(0);
    expect(output).toContain('usage');
  });

  it('--bogus exits non-zero with a usage hint', () => {
    const { code, stdout, stderr } = run(['--bogus']);
    expect(code).not.toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('unknown');
  });

  it('init --help prints init usage and exits 0', () => {
    const { code, stdout, stderr } = run(['init', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('init');
    expect(output).toContain('--force');
  });

  it('init without args prints not-yet-implemented (Phase 1 stub)', () => {
    const { code, stdout, stderr } = run(['init']);
    const output = stdout + stderr;
    expect(output).toContain('not yet implemented');
    expect(code).not.toBe(0);
  });

  it('<branch> --help prints up usage and exits 0', () => {
    const { code, stdout, stderr } = run(['my-feature', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('my-feature');
  });

  it('--list --help prints list usage and exits 0', () => {
    const { code, stdout, stderr } = run(['--list', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('list');
  });
});
