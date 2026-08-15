import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { dispatch } from '../src/cli.js';
import type { DevboxProvider, ProviderActionResult } from '../src/providers/types.js';
import type { ProviderRegistry } from '../src/providers/registry.js';

function action(): Promise<ProviderActionResult> {
  return Promise.resolve({ exitCode: 0 });
}

function provider(name: 'local' | 'vercel'): DevboxProvider {
  return {
    name,
    up: vi.fn(action),
    attach: vi.fn(action),
    stop: vi.fn(action),
    remove: vi.fn(action),
    list: vi.fn(action),
    url: vi.fn(action),
    getDisplayCredentials: vi.fn(async () => ({
      supported: false as const,
      message: 'unsupported',
    })),
  };
}

function streams(): { stdout: PassThrough; stderr: PassThrough; output: () => { stdout: string; stderr: string } } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = '';
  let stderrText = '';
  stdout.on('data', (chunk) => { stdoutText += chunk.toString(); });
  stderr.on('data', (chunk) => { stderrText += chunk.toString(); });
  return { stdout, stderr, output: () => ({ stdout: stdoutText, stderr: stderrText }) };
}

describe('CLI provider routing', () => {
  it('selects the local provider when --provider is omitted', async () => {
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };
    const io = streams();

    const code = await dispatch(['feature'], io, { repoRoot: '/repo', registry, tty: false });

    expect(code).toBe(0);
    expect(local.up).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
    expect(vercel.up).not.toHaveBeenCalled();
  });

  it('routes an explicit provider for branch lifecycle actions', async () => {
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };
    const io = streams();

    const code = await dispatch(
      ['--provider', 'vercel', 'feature', '--attach'],
      io,
      { repoRoot: '/repo', registry, tty: false },
    );

    expect(code).toBe(0);
    expect(vercel.attach).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
    expect(local.attach).not.toHaveBeenCalled();
  });

  it('routes provider-filtered list operations and defaults list to local', async () => {
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };

    const defaultIo = streams();
    expect(await dispatch(['--list'], defaultIo, { repoRoot: '/repo', registry, tty: false })).toBe(0);
    expect(local.list).toHaveBeenCalledTimes(1);
    expect(vercel.list).not.toHaveBeenCalled();

    const explicitIo = streams();
    expect(
      await dispatch(['--list', '--provider', 'vercel'], explicitIo, {
        repoRoot: '/repo',
        registry,
        tty: false,
      }),
    ).toBe(0);
    expect(vercel.list).toHaveBeenCalledTimes(1);
  });

  it('retrieves labeled display credentials as a first-class action', async () => {
    const local = provider('local');
    local.getDisplayCredentials = vi.fn(async () => ({
      supported: true as const,
      username: 'display-user',
      password: 'display-pass',
    }));
    const registry: ProviderRegistry = { local, vercel: provider('vercel') };
    const io = streams();

    const code = await dispatch(['feature', '--password'], io, {
      repoRoot: '/repo',
      registry,
      tty: false,
    });

    expect(code).toBe(0);
    expect(io.output().stdout).toBe(`username: display-user\npassword: display-pass\n`);
    expect(local.getDisplayCredentials).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
  });

  it('returns a concise nonzero result for unsupported local credentials', async () => {
    const local = provider('local');
    const io = streams();

    const code = await dispatch(['feature', '--password'], io, {
      repoRoot: '/repo',
      registry: { local, vercel: provider('vercel') },
      tty: false,
    });

    expect(code).toBe(2);
    expect(io.output().stderr).toContain('unsupported');
  });

  it('rejects unsupported, missing, conflicting, and misplaced arguments', async () => {
    const cases: Array<{ args: string[]; message: string }> = [
      { args: ['feature', '--provider'], message: 'missing provider value' },
      { args: ['feature', '--provider', 'aws'], message: 'unsupported provider' },
      { args: ['feature', '--stop', '--rm'], message: 'conflicting action flags' },
      { args: ['feature', '--bogus'], message: 'unknown or misplaced option' },
      { args: ['--provider', 'local', '--attach'], message: 'branch is required' },
      { args: ['init', '--provider', 'local'], message: 'unknown or misplaced option for init' },
      { args: ['--list', '--password'], message: 'misplaced or unknown flag for --list' },
    ];

    for (const { args, message } of cases) {
      const io = streams();
      const code = await dispatch(args, io, {
        repoRoot: '/repo',
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(2);
      expect(io.output().stderr.toLowerCase(), args.join(' ')).toContain(message);
    }
  });

  it('rejects invalid init flags even when init help is requested', async () => {
    const cases: Array<{ args: string[]; message: string }> = [
      { args: ['init', '--help', '--provider', 'local'], message: 'unknown or misplaced option for init' },
      { args: ['init', '--help', '--unknown'], message: 'unknown or misplaced option for init' },
    ];

    for (const { args, message } of cases) {
      const io = streams();
      const code = await dispatch(args, io, {
        repoRoot: '/repo',
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(2);
      expect(io.output().stderr.toLowerCase(), args.join(' ')).toContain(message);
    }
  });

  it('preserves provider-prefixed global help without trailing tokens', async () => {
    for (const args of [['--provider', 'local', '--help'], ['--provider', 'local', '-h']]) {
      const io = streams();
      const code = await dispatch(args, io, {
        repoRoot: '/repo',
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(0);
      expect(io.output().stdout, args.join(' ')).toContain('devbox');
      expect(io.output().stderr, args.join(' ')).toBe('');
    }
  });

  it('rejects trailing tokens after global help, including provider-prefixed help', async () => {
    const cases = [
      ['--provider', 'local', '--help', 'init'],
      ['--provider', 'local', '-h', 'init'],
      ['--provider', 'local', '--help', '--unknown'],
      ['--provider', 'local', '-h', '--unknown'],
      ['--help', 'init'],
      ['-h', 'init'],
    ];

    for (const args of cases) {
      const io = streams();
      const code = await dispatch(args, io, {
        repoRoot: '/repo',
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(2);
      expect(io.output().stdout, args.join(' ')).toBe('');
      expect(io.output().stderr, args.join(' ')).toContain('usage:');
    }
  });

  it('propagates provider operation errors with their stable exit code', async () => {
    const local = provider('local');
    local.up = vi.fn(async () => {
      throw Object.assign(new Error('provider failed'), { exitCode: 7 });
    });
    const io = streams();

    const code = await dispatch(['feature'], io, {
      repoRoot: '/repo',
      registry: { local, vercel: provider('vercel') },
      tty: false,
    });

    expect(code).toBe(7);
    expect(io.output().stderr).toContain('provider failed');
  });

  it('routes every lifecycle action through the selected provider', async () => {
    const local = provider('local');
    const registry: ProviderRegistry = { local, vercel: provider('vercel') };
    const actions: Array<{ args: string[]; method: 'up' | 'stop' | 'remove' | 'url' }> = [
      { args: ['feature'], method: 'up' },
      { args: ['feature', '--stop'], method: 'stop' },
      { args: ['feature', '--rm'], method: 'remove' },
      { args: ['feature', '--url', '--open'], method: 'url' },
    ];

    for (const { args, method } of actions) {
      const io = streams();
      const code = await dispatch(args, io, { repoRoot: '/repo', registry, tty: false });
      expect(code).toBe(0);
      expect(local[method]).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
    }
    expect(local.url).toHaveBeenCalledWith(expect.objectContaining({ open: true }));
  });
});
