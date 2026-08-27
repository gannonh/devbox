import { describe, it, expect } from 'vitest';
import { dispatch, parseCliArgs, resolveBranchAction } from '../src/cli.js';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PACKAGE_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d.toString()));
  stderr.on('data', (d) => (err += d.toString()));
  const code = dispatch(args, { stdin, stdout, stderr });
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
    expect(output).toContain('--pause');
    expect(output).toContain('--stop');
    expect(output).toContain('--rm');
    expect(output).toContain('--list');
    expect(output).toContain('--url');
    expect(output).toContain('--provider local|vercel');
    expect(output).toContain('--password');
    expect(output).toContain('--env <path>');
    expect(output).toContain('--version');
    expect(output).toContain('scaffold .devbox/ (required for local)');
    expect(output).toContain('Vercel does not require init');
    expect(output).toContain('devbox --provider vercel my-feature');
  });

  it('--version prints the installed package version and exits 0', async () => {
    const { code, stdout, stderr } = await run(['--version']);

    expect(code).toBe(0);
    expect(stdout).toBe(`${PACKAGE_VERSION}\n`);
    expect(stderr).toBe('');
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
    expect(output).toContain('Local boxes require this');
    expect(output).toContain('Vercel boxes do not');
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
    expect(output).toContain('--provider local|vercel');
    expect(output).toContain('Ctrl-]');
    expect(output).toContain('VERCEL CORE');
    expect(output).toContain('No .devbox/ or .devcontainer/ is required');
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

  it('<branch> --pause --help prints pause usage and exits 0', async () => {
    const { code, stdout, stderr } = await run(['my-feature', '--pause', '--help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('--pause');
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

  it('returns { action: "pause" } for --pause', () => {
    expect(resolveBranchAction(['--pause'])).toEqual({ action: 'pause' });
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

  it('returns { action: "password" } for --password', () => {
    expect(resolveBranchAction(['--password'])).toEqual({ action: 'password' });
  });
});

describe('--env parsing', () => {
  it('parses a dotenv path for a boot', () => {
    expect(parseCliArgs(['feature/ui', '--env', '/tmp/project.env'])).toEqual({
      kind: 'branch',
      branch: 'feature/ui',
      action: { action: 'up' },
      envPath: '/tmp/project.env',
    });
  });

  it('parses a dotenv path for attach', () => {
    expect(parseCliArgs(['feature/ui', '--attach', '--env', 'project.env']))
      .toMatchObject({ action: { action: 'attach' }, envPath: 'project.env' });
  });

  it.each([
    ['--pause', /--env is not valid with --pause/],
    ['--stop', /--env is not valid with --stop/],
    ['--url', /--env is not valid with --url/],
    ['--rm', /--env is not valid with --rm/],
    ['--password', /--env is not valid with --password/],
  ])('rejects --env with %s', (flag, message) => {
    const parsed = parseCliArgs(['feature/ui', flag, '--env', 'project.env']);
    expect(parsed).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((parsed as { message: string }).message).toMatch(message);
  });

  it.each([
    ['a missing value', ['feature/ui', '--env'], /missing env file path/],
    ['a flag as the value', ['feature/ui', '--env', '--attach'], /missing env file path/],
    ['a duplicate flag', ['feature/ui', '--env', 'one.env', '--env', 'two.env'], /duplicate --env/],
  ])('rejects %s', (_label, args, message) => {
    const parsed = parseCliArgs(args);
    expect(parsed).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((parsed as { message: string }).message).toMatch(message);
  });
});

describe('--expose-ports parsing', () => {
  it('parses a comma-separated list for a boot', () => {
    expect(parseCliArgs(['feature/ui', '--provider', 'vercel', '--expose-ports', '5173, 3000']))
      .toEqual({
        kind: 'branch',
        branch: 'feature/ui',
        provider: 'vercel',
        action: { action: 'up' },
        exposePorts: [5173, 3000],
      });
  });

  it('parses the flag for --attach', () => {
    expect(parseCliArgs(['feature/ui', '--attach', '--expose-ports', '5173']))
      .toMatchObject({ action: { action: 'attach' }, exposePorts: [5173] });
  });

  it.each([
    ['--url', /--expose-ports is not valid with --url/],
    ['--open', /--expose-ports is not valid with --url/],
    ['--pause', /--expose-ports is not valid with --pause/],
    ['--stop', /--expose-ports is not valid with --stop/],
    ['--rm', /--expose-ports is not valid with --rm/],
    ['--password', /--expose-ports is not valid with --password/],
  ])('rejects the flag with %s', (flag, message) => {
    const parsed = parseCliArgs(['feature/ui', flag, '--expose-ports', '5173']);
    expect(parsed.kind).toBe('error');
    expect(parsed).toMatchObject({ exitCode: 2 });
    expect((parsed as { message: string }).message).toMatch(message);
  });

  it('rejects the flag on --list', () => {
    const parsed = parseCliArgs(['--list', '--expose-ports', '5173']);
    expect(parsed).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((parsed as { message: string }).message)
      .toMatch(/only valid when booting or attaching a branch/);
  });

  it.each([
    ['a missing value', ['feature/ui', '--expose-ports'], /missing comma-separated port list/],
    ['a flag as the value', ['feature/ui', '--expose-ports', '--attach'], /missing comma-separated port list/],
    ['a non-decimal entry', ['feature/ui', '--expose-ports', 'web'], /not a decimal port/],
    ['a duplicate entry', ['feature/ui', '--expose-ports', '5173,5173'], /duplicate/],
    ['the private VNC port', ['feature/ui', '--expose-ports', '5900'], /VNC port stays private/],
    ['the internal noVNC port', ['feature/ui', '--expose-ports', '6081'], /internal noVNC port stays private/],
    ['a duplicate flag', ['feature/ui', '--expose-ports', '5173', '--expose-ports', '3000'], /duplicate --expose-ports/],
  ])('rejects %s', (_label, args, message) => {
    const parsed = parseCliArgs(args);
    expect(parsed).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((parsed as { message: string }).message).toMatch(message);
  });

  it('reports the flag as unsupported for the local provider', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-expose-ports-cli-'));
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let err = '';
      stderr.on('data', (chunk) => (err += chunk.toString()));
      const code = await dispatch(
        ['feature/ui', '--provider', 'local', '--expose-ports', '5173'],
        { stdin, stdout, stderr },
        { repoRoot: process.cwd(), stateHome, env: {}, tty: false },
      );

      expect(code).toBe(2);
      expect(err).toContain('--expose-ports is not supported by the local provider');
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it('documents the flag in the boot and global help', async () => {
    const global = await run(['--help']);
    const boot = await run(['feature/ui', '--help']);

    expect(global.stdout + global.stderr).toContain('--expose-ports <list>');
    expect(global.stdout + global.stderr).toContain('--env <path>');
    expect(boot.stdout + boot.stderr).toContain('--expose-ports <list>');
    expect(boot.stdout + boot.stderr).toContain('--env <path>');
  });
});

describe('--timeout and --vcpus parsing', () => {
  it('parses minutes to milliseconds and vcpus for a Vercel boot', () => {
    expect(parseCliArgs(['mybranch', '--provider', 'vercel', '--timeout', '90', '--vcpus', '4']))
      .toEqual({
        kind: 'branch',
        branch: 'mybranch',
        provider: 'vercel',
        action: { action: 'up' },
        timeoutMs: 5_400_000,
        vcpus: 4,
      });
  });

  it('parses both flags for --attach', () => {
    expect(parseCliArgs(['feature/ui', '--attach', '--timeout', '60', '--vcpus', '2']))
      .toMatchObject({ action: { action: 'attach' }, timeoutMs: 3_600_000, vcpus: 2 });
  });

  it('accepts the range boundaries', () => {
    expect(parseCliArgs(['feature/ui', '--timeout', '1'])).toMatchObject({ timeoutMs: 60_000 });
    expect(parseCliArgs(['feature/ui', '--timeout', '1440'])).toMatchObject({ timeoutMs: 86_400_000 });
    expect(parseCliArgs(['feature/ui', '--vcpus', '1'])).toMatchObject({ vcpus: 1 });
    expect(parseCliArgs(['feature/ui', '--vcpus', '32'])).toMatchObject({ vcpus: 32 });
  });

  it.each([
    ['zero minutes', ['feature/ui', '--timeout', '0'], /timeout must be an integer between 1 and 1440/],
    ['minutes over the 24h maximum', ['feature/ui', '--timeout', '1441'], /timeout must be an integer between 1 and 1440/],
    ['a non-numeric timeout', ['feature/ui', '--timeout', 'abc'], /timeout must be an integer between 1 and 1440/],
    ['a missing timeout value', ['feature/ui', '--timeout'], /missing timeout in minutes/],
    ['an odd vcpu count', ['feature/ui', '--vcpus', '3'], /vcpus must be a positive integer that is 1 or even, up to 32/],
    ['zero vcpus', ['feature/ui', '--vcpus', '0'], /vcpus must be a positive integer that is 1 or even, up to 32/],
    ['vcpus over the maximum', ['feature/ui', '--vcpus', '33'], /vcpus must be a positive integer that is 1 or even, up to 32/],
    ['a missing vcpus value', ['feature/ui', '--vcpus'], /missing vCPU count/],
    ['a duplicate --timeout flag', ['feature/ui', '--timeout', '30', '--timeout', '90'], /duplicate --timeout flag/],
    ['a duplicate --vcpus flag', ['feature/ui', '--vcpus', '2', '--vcpus', '4'], /duplicate --vcpus flag/],
  ])('rejects %s', (_label, args, message) => {
    const parsed = parseCliArgs(args);
    expect(parsed).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((parsed as { message: string }).message).toMatch(message);
  });

  it.each([
    ['--pause', /--timeout is not valid with --pause/],
    ['--stop', /--timeout is not valid with --stop/],
    ['--rm', /--timeout is not valid with --rm/],
    ['--url', /--timeout is not valid with --url/],
  ])('rejects --timeout with %s', (flag, message) => {
    const parsed = parseCliArgs(['feature/ui', flag, '--timeout', '90']);
    expect(parsed).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((parsed as { message: string }).message).toMatch(message);
  });

  it.each([
    ['--pause', /--vcpus is not valid with --pause/],
    ['--stop', /--vcpus is not valid with --stop/],
    ['--rm', /--vcpus is not valid with --rm/],
    ['--url', /--vcpus is not valid with --url/],
  ])('rejects --vcpus with %s', (flag, message) => {
    const parsed = parseCliArgs(['feature/ui', flag, '--vcpus', '4']);
    expect(parsed).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((parsed as { message: string }).message).toMatch(message);
  });

  it('rejects the flags on --list with the targeted message', () => {
    const timeout = parseCliArgs(['--list', '--timeout', '90']);
    expect(timeout).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((timeout as { message: string }).message)
      .toMatch(/--timeout is only valid when booting or attaching a branch/);
    const vcpus = parseCliArgs(['--list', '--vcpus', '4']);
    expect(vcpus).toMatchObject({ kind: 'error', exitCode: 2 });
    expect((vcpus as { message: string }).message)
      .toMatch(/--vcpus is only valid when booting or attaching a branch/);
  });

  it('reports each flag as unsupported for the local provider', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'devbox-resources-cli-'));
    try {
      for (const flag of ['--timeout', '--vcpus']) {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let err = '';
        stderr.on('data', (chunk) => (err += chunk.toString()));
        const args = flag === '--timeout'
          ? ['feature/ui', '--provider', 'local', '--timeout', '90']
          : ['feature/ui', '--provider', 'local', '--vcpus', '4'];
        const code = await dispatch(
          args,
          { stdin, stdout, stderr },
          { repoRoot: process.cwd(), stateHome, env: {}, tty: false },
        );

        expect(code).toBe(2);
        expect(err).toContain(`${flag} is not supported by the local provider`);
      }
    } finally {
      await rm(stateHome, { recursive: true, force: true });
    }
  });

  it('documents the flags in the boot and global help', async () => {
    const global = await run(['--help']);
    const boot = await run(['feature/ui', '--help']);

    expect(global.stdout + global.stderr).toContain('--timeout <minutes>');
    expect(global.stdout + global.stderr).toContain('--vcpus <n>');
    expect(boot.stdout + boot.stderr).toContain('--timeout <minutes>');
    expect(boot.stdout + boot.stderr).toContain('--vcpus <n>');
  });
});
