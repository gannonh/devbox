import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

function streams(): { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; output: () => { stdout: string; stderr: string } } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = '';
  let stderrText = '';
  stdout.on('data', (chunk) => { stdoutText += chunk.toString(); });
  stderr.on('data', (chunk) => { stderrText += chunk.toString(); });
  return { stdin, stdout, stderr, output: () => ({ stdout: stdoutText, stderr: stderrText }) };
}

let repoCounter = 0;
/** A distinct repository per test: the remembered provider is per-repo state. */
function repoRoot(): string {
  repoCounter += 1;
  return `/repo-${repoCounter}`;
}

describe('CLI provider routing', () => {
  it('returns the local provider unsupported result for --password by default', async () => {
    const root = repoRoot();
    const io = streams();
    const code = await dispatch(['feature', '--password'], io, {
      repoRoot: root,
      tty: false,
    });

    expect(code).toBe(2);
    expect(io.output().stderr).toContain('unsupported');
  });

  it('selects the local provider when --provider is omitted', async () => {
    const root = repoRoot();
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };
    const io = streams();

    const code = await dispatch(['feature'], io, { repoRoot: root, registry, tty: false });

    expect(code).toBe(0);
    expect(local.up).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
    expect(vercel.up).not.toHaveBeenCalled();
  });

  it('passes the caller-owned stdin to the selected provider', async () => {
    const root = repoRoot();
    const local = provider('local');
    const input = new PassThrough();
    const io = { ...streams(), stdin: input };
    const code = await dispatch(['feature'], io, {
      repoRoot: root,
      registry: { local, vercel: provider('vercel') },
      tty: true,
    });

    expect(code).toBe(0);
    expect(local.up).toHaveBeenCalledWith(expect.objectContaining({ stdin: input, tty: true }));
  });

  it('routes an explicit provider for branch lifecycle actions', async () => {
    const root = repoRoot();
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };
    const io = streams();

    const code = await dispatch(
      ['--provider', 'vercel', 'feature', '--attach'],
      io,
      { repoRoot: root, registry, tty: false },
    );

    expect(code).toBe(0);
    expect(vercel.attach).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
    expect(local.attach).not.toHaveBeenCalled();
  });

  it('routes provider-filtered list operations and defaults list to local', async () => {
    const root = repoRoot();
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };

    const defaultIo = streams();
    expect(await dispatch(['--list'], defaultIo, { repoRoot: root, registry, tty: false })).toBe(0);
    expect(local.list).toHaveBeenCalledTimes(1);
    expect(vercel.list).not.toHaveBeenCalled();

    const explicitIo = streams();
    expect(
      await dispatch(['--list', '--provider', 'vercel'], explicitIo, {
        repoRoot: root,
        registry,
        tty: false,
      }),
    ).toBe(0);
    expect(vercel.list).toHaveBeenCalledTimes(1);
  });

  it('retrieves labeled display credentials as a first-class action', async () => {
    const root = repoRoot();
    const local = provider('local');
    local.getDisplayCredentials = vi.fn(async () => ({
      supported: true as const,
      username: 'display-user',
      password: 'display-pass',
    }));
    const io = streams();

    const code = await dispatch(['feature', '--password'], io, {
      repoRoot: root,
      registry: { local, vercel: provider('vercel') },
      tty: false,
    });

    expect(code).toBe(0);
    expect(io.output().stdout).toBe('username: display-user\npassword: display-pass\n');
    expect(local.getDisplayCredentials).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
  });

  it('remembers the provider per repository until it is changed', async () => {
    const root = repoRoot();
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };

    // Choose vercel once.
    expect(await dispatch(['--provider', 'vercel', 'feature'], streams(), { repoRoot: root, registry, tty: false })).toBe(0);
    expect(vercel.up).toHaveBeenCalledTimes(1);

    // A bare command now routes to vercel, and says so -- a remembered cloud
    // provider spends money, so it is never applied silently.
    const rememberedIo = streams();
    expect(await dispatch(['feature'], rememberedIo, { repoRoot: root, registry, tty: false })).toBe(0);
    expect(vercel.up).toHaveBeenCalledTimes(2);
    expect(local.up).not.toHaveBeenCalled();
    expect(rememberedIo.output().stderr).toContain('[devbox/vercel] (change with --provider [local|vercel])');

    // --provider local switches back and stops the notice.
    const switchIo = streams();
    expect(await dispatch(['--provider', 'local', 'feature'], switchIo, { repoRoot: root, registry, tty: false })).toBe(0);
    expect(local.up).toHaveBeenCalledTimes(1);
    expect(switchIo.output().stderr).not.toContain('[devbox/');

    const afterSwitchIo = streams();
    expect(await dispatch(['feature'], afterSwitchIo, { repoRoot: root, registry, tty: false })).toBe(0);
    expect(local.up).toHaveBeenCalledTimes(2);
    expect(afterSwitchIo.output().stderr).not.toContain('[devbox/');
  });

  it('falls back to local when the stored preference is unreadable', async () => {
    const root = repoRoot();
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };

    expect(await dispatch(['--provider', 'vercel', 'feature'], streams(), { repoRoot: root, registry, tty: false })).toBe(0);

    // Corrupt the stored choice: a bad state file must not break the CLI.
    const key = createHash('sha256').update(root).digest('hex').slice(0, 32);
    const path = join(process.env.XDG_STATE_HOME as string, 'devbox', 'repos', `${key}.json`);
    writeFileSync(path, '{ not json');

    const io = streams();
    expect(await dispatch(['feature'], io, { repoRoot: root, registry, tty: false })).toBe(0);
    expect(local.up).toHaveBeenCalledTimes(1);
    expect(io.output().stderr).not.toContain('[devbox/');
  });

  it('sets the provider for the repository with no branch and no action', async () => {
    const root = repoRoot();
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };

    const setIo = streams();
    expect(await dispatch(['--provider', 'vercel'], setIo, { repoRoot: root, registry, tty: false })).toBe(0);
    expect(setIo.output().stdout).toContain('provider set to vercel');
    // Setting a preference must not run a lifecycle action.
    expect(vercel.up).not.toHaveBeenCalled();
    expect(vercel.list).not.toHaveBeenCalled();

    // And it takes effect for later commands.
    expect(await dispatch(['feature'], streams(), { repoRoot: root, registry, tty: false })).toBe(0);
    expect(vercel.up).toHaveBeenCalledTimes(1);

    const resetIo = streams();
    expect(await dispatch(['--provider', 'local'], resetIo, { repoRoot: root, registry, tty: false })).toBe(0);
    expect(resetIo.output().stdout).toContain('provider set to local');
    expect(await dispatch(['feature'], streams(), { repoRoot: root, registry, tty: false })).toBe(0);
    expect(local.up).toHaveBeenCalledTimes(1);
  });

  it('keeps the remembered provider scoped to one repository', async () => {
    const chosen = repoRoot();
    const untouched = repoRoot();
    const local = provider('local');
    const vercel = provider('vercel');
    const registry: ProviderRegistry = { local, vercel };

    expect(await dispatch(['--provider', 'vercel', 'feature'], streams(), { repoRoot: chosen, registry, tty: false })).toBe(0);

    // A different checkout must not inherit it; two repos routinely differ.
    expect(await dispatch(['feature'], streams(), { repoRoot: untouched, registry, tty: false })).toBe(0);
    expect(local.up).toHaveBeenCalledTimes(1);
    expect(vercel.up).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported, missing, conflicting, and misplaced arguments', async () => {
    const root = repoRoot();
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
        repoRoot: root,
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(2);
      expect(io.output().stderr.toLowerCase(), args.join(' ')).toContain(message);
    }
  });

  it('rejects invalid init flags even when init help is requested', async () => {
    const root = repoRoot();
    const cases: Array<{ args: string[]; message: string }> = [
      { args: ['init', '--help', '--provider', 'local'], message: 'unknown or misplaced option for init' },
      { args: ['init', '--help', '--unknown'], message: 'unknown or misplaced option for init' },
    ];

    for (const { args, message } of cases) {
      const io = streams();
      const code = await dispatch(args, io, {
        repoRoot: root,
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(2);
      expect(io.output().stderr.toLowerCase(), args.join(' ')).toContain(message);
    }
  });

  it('preserves provider-prefixed global help without trailing tokens', async () => {
    const root = repoRoot();
    for (const args of [['--provider', 'local', '--help'], ['--provider', 'local', '-h']]) {
      const io = streams();
      const code = await dispatch(args, io, {
        repoRoot: root,
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(0);
      expect(io.output().stdout, args.join(' ')).toContain('devbox');
      expect(io.output().stderr, args.join(' ')).toBe('');
    }
  });

  it('rejects trailing tokens after global help, including provider-prefixed help', async () => {
    const root = repoRoot();
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
        repoRoot: root,
        registry: { local: provider('local'), vercel: provider('vercel') },
        tty: false,
      });
      expect(code, args.join(' ')).toBe(2);
      expect(io.output().stdout, args.join(' ')).toBe('');
      expect(io.output().stderr, args.join(' ')).toContain('usage:');
    }
  });

  it('propagates provider operation errors with their stable exit code', async () => {
    const root = repoRoot();
    const local = provider('local');
    local.up = vi.fn(async () => {
      throw Object.assign(new Error('provider failed'), { exitCode: 7 });
    });
    const io = streams();

    const code = await dispatch(['feature'], io, {
      repoRoot: root,
      registry: { local, vercel: provider('vercel') },
      tty: false,
    });

    expect(code).toBe(7);
    expect(io.output().stderr).toContain('provider failed');
  });

  it('routes every lifecycle action through the selected provider', async () => {
    const root = repoRoot();
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
      const code = await dispatch(args, io, { repoRoot: root, registry, tty: false });
      expect(code).toBe(0);
      expect(local[method]).toHaveBeenCalledWith(expect.objectContaining({ branch: 'feature' }));
    }
    expect(local.url).toHaveBeenCalledWith(expect.objectContaining({ open: true }));
  });
});
