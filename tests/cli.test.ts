import { describe, it, expect } from 'vitest';
import { dispatch, resolveBranchAction } from '../src/cli.js';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d.toString()));
  stderr.on('data', (d) => (err += d.toString()));
  const code = dispatch(args, { stdout, stderr });
  return { code: await Promise.resolve(code), stdout: out, stderr: err };
}

describe('cli dispatch', () => {
  it('--help prints usage with command list and exits 0', async () => {
    const { code, stdout, stderr } = await run(['--help']);
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

  it('-h alias also prints help and exits 0', async () => {
    const { code } = await run(['-h']);
    expect(code).toBe(0);
  });

  it('no args prints usage and exits non-zero', async () => {
    const { code, stdout, stderr } = await run([]);
    const output = stdout + stderr;
    expect(code).not.toBe(0);
    expect(output).toContain('usage');
  });

  it('--bogus exits non-zero with a usage hint', async () => {
    const { code, stdout, stderr } = await run(['--bogus']);
    expect(code).not.toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('unknown');
  });

  it('init --help prints init usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['init', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('init');
    expect(output).toContain('--force');
  });

  it('init creates .devbox/ files and exits 0', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'devbox-cli-'));
    const origCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const { code, stderr } = await run(['init']);
      expect(code).toBe(0);
      expect(stderr).toContain('[devbox] created:');
      expect(stderr).toContain('.devbox/Dockerfile');
      expect(stderr).toContain('.devbox/provision.sh');
      expect(stderr).toContain('.devcontainer/devcontainer.json');
    } finally {
      process.chdir(origCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('<branch> --help prints up usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['my-feature', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('my-feature');
  });

  it('--list --help prints list usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['--list', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('list');
  });

  it('<branch> --attach --help prints attach usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['my-feature', '--attach', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('attach');
    expect(output).toContain('USAGE');
  });

  it('<branch> --stop --help prints stop usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['my-feature', '--stop', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('stop');
    expect(output).toContain('USAGE');
  });

  it('<branch> --rm --help prints rm usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['my-feature', '--rm', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('rm');
    expect(output).toContain('USAGE');
  });

  it('<branch> --url --help prints url usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['my-feature', '--url', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('url');
    expect(output).toContain('USAGE');
  });
});

describe('resolveBranchAction', () => {
  it('returns { action: "up" } when no flags present', () => {
    expect(resolveBranchAction([])).toEqual({ action: 'up' });
  });

  it('returns { action: "attach" } for --attach', () => {
    expect(resolveBranchAction(['--attach'])).toEqual({ action: 'attach' });
  });

  it('returns { action: "stop" } for --stop', () => {
    expect(resolveBranchAction(['--stop'])).toEqual({ action: 'stop' });
  });

  it('returns { action: "rm" } for --rm', () => {
    expect(resolveBranchAction(['--rm'])).toEqual({ action: 'rm' });
  });

  it('returns { action: "url", open: false } for --url alone', () => {
    expect(resolveBranchAction(['--url'])).toEqual({ action: 'url', open: false });
  });

  it('returns { action: "url", open: true } for --url --open', () => {
    expect(resolveBranchAction(['--url', '--open'])).toEqual({ action: 'url', open: true });
  });

  it('returns { action: "url", open: true } for --open alone', () => {
    expect(resolveBranchAction(['--open'])).toEqual({ action: 'url', open: true });
  });

  it('returns { action: "url", open: true } for -o alone', () => {
    expect(resolveBranchAction(['-o'])).toEqual({ action: 'url', open: true });
  });
});
