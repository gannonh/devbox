import { describe, expect, it, vi } from 'vitest';
import { access, readFile, stat } from 'node:fs/promises';
import { normalizeGitHubRemote } from '../src/providers/vercel/identity.js';
import {
  normalizeGitHubSourceRemote,
  resolveGitHubSource,
  resolveVercelRepositoryCwd,
  resolveGitHubSourceOrigin,
  resolveGitHubToken,
  selectGitHubRevision,
} from '../src/providers/vercel/source.js';

const noOpShell = {
  execQuiet: vi.fn(),
  spawnInherit: vi.fn(),
};

describe('Vercel GitHub source selection', () => {
  it('derives the clone cwd from the SDK session cwd and normalized repository name', () => {
    expect(resolveVercelRepositoryCwd('/vercel/sandbox', 'repo')).toBe('/vercel/sandbox/repo');
    expect(resolveVercelRepositoryCwd(undefined, 'repo')).toBe('/vercel/sandbox/repo');
    expect(() => resolveVercelRepositoryCwd('/vercel/sandbox', 'owner/repo')).toThrow(/normalized/i);
  });

  it('resolves a local origin without querying remote branch state or credentials', async () => {
    const exec = vi.fn(async () => 'git@github.com:Acme/Repo.git');
    const execQuiet = vi.fn();
    const origin = await resolveGitHubSourceOrigin({
      repoRoot: '/repo',
      shellRunner: { ...noOpShell, exec, execQuiet },
    });

    expect(origin).toMatchObject({
      canonical: 'github.com/acme/repo',
      url: 'https://github.com/acme/repo.git',
    });
    expect(exec).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], expect.objectContaining({ cwd: '/repo' }));
    expect(execQuiet).not.toHaveBeenCalled();
  });

  it('redacts configured credentials from invalid-origin errors', async () => {
    const token = 'github-origin-secret';
    const shellRunner = {
      ...noOpShell,
      exec: vi.fn(async () => `https://github.com/acme/repo?token=${token}`),
      execQuiet: vi.fn(),
    };

    let caught: unknown;
    try {
      await resolveGitHubSource({
        repoRoot: '/repo',
        branch: 'feature/ui',
        env: { GH_TOKEN: token },
        shellRunner,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(token);
  });

  it('rejects multiline environment credentials before source creation', async () => {
    await expect(resolveGitHubToken({
      repoRoot: '/repo',
      env: { GH_TOKEN: 'bad\ntoken', GITHUB_TOKEN: 'fallback' },
      shellRunner: { ...noOpShell, exec: vi.fn() },
    })).rejects.toThrow(/single-line/i);
  });

  it('uses the injected gh auth token command without putting the token in argv', async () => {
    const runner = {
      ...noOpShell,
      exec: vi.fn(async () => 'command-token'),
    };

    await expect(resolveGitHubToken({
      repoRoot: '/repo',
      env: {},
      shellRunner: runner,
    })).resolves.toBe('command-token');
    expect(runner.exec).toHaveBeenCalledWith('gh', ['auth', 'token'], expect.objectContaining({ cwd: '/repo' }));
    expect(runner.exec.mock.calls[0][1]).not.toContain('command-token');
  });

  it('uses GH_TOKEN before GITHUB_TOKEN without invoking gh', async () => {
    const runner = { ...noOpShell, exec: vi.fn() };

    await expect(resolveGitHubToken({
      repoRoot: '/repo',
      env: { GH_TOKEN: 'first-token', GITHUB_TOKEN: 'second-token' },
      shellRunner: runner,
    })).resolves.toBe('first-token');
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it('authenticates private default and branch probes through a token-free askpass helper', async () => {
    const token = 'private-github-token';
    const events: string[] = [];
    const observed: Array<{ args: string[]; env: Record<string, string | undefined>; helper: string }> = [];
    let helperContent = '';
    let helperMode = 0;
    const shellRunner = {
      ...noOpShell,
      exec: vi.fn(async (command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
        if (args[0] === 'remote') return 'https://github.com/acme/private.git';
        if (command === 'gh') {
          events.push('token');
          return token;
        }
        if (args[0] === 'ls-remote') {
          events.push(args.includes('--symref') ? 'default' : 'branch');
          const helper = options?.env?.GIT_ASKPASS;
          expect(helper).toBeTruthy();
          helperContent = await readFile(helper!, 'utf8');
          helperMode = (await stat(helper!)).mode & 0o777;
          observed.push({ args, env: options?.env ?? {}, helper: helper! });
          return args.includes('--symref') ? 'ref: refs/heads/main\tHEAD\n' : '';
        }
        throw new Error(`unexpected command ${command} ${args.join(' ')}`);
      }),
      execQuiet: vi.fn(async (_command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
        events.push('branch');
        const helper = options?.env?.GIT_ASKPASS;
        expect(helper).toBeTruthy();
        observed.push({ args, env: options?.env ?? {}, helper: helper! });
        return { stdout: 'def\trefs/heads/feature/ui\n', code: 0 };
      }),
    };

    const result = await resolveGitHubSource({
      repoRoot: '/repo',
      branch: 'feature/ui',
      env: {},
      shellRunner,
    });

    expect(result.source.password).toBe(token);
    expect(events).toEqual(['token', 'default', 'branch']);
    expect(observed).toHaveLength(2);
    expect(observed.every(({ args }) => !args.includes(token) && !args.join(' ').includes(token))).toBe(true);
    expect(observed.every(({ env }) => env.GIT_PASSWORD === token
      && env.GIT_TERMINAL_PROMPT === '0'
      && env.GIT_ASKPASS
      && env.GH_TOKEN === undefined
      && env.GITHUB_TOKEN === undefined)).toBe(true);
    expect(helperContent).not.toContain(token);
    expect(helperMode).toBe(0o700);
    await expect(access(observed[0].helper)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('labels authenticated source probe failures with a stable source code', async () => {
    const shellRunner = {
      ...noOpShell,
      exec: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === 'remote') return 'https://github.com/acme/private.git';
        if (args[0] === 'ls-remote') throw Object.assign(new Error('access denied'), { status: 403 });
        throw new Error('unexpected command');
      }),
      execQuiet: vi.fn(),
    };

    await expect(resolveGitHubSource({
      repoRoot: '/repo',
      branch: 'feature/ui',
      env: { GH_TOKEN: 'token' },
      shellRunner,
    })).rejects.toMatchObject({
      code: 'github_source_access_denied',
      operation: 'source',
      status: 403,
    });
  });

  it('resolves origin and remote branch state without putting a token in argv', async () => {
    const token = 'gh-secret-token';
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const shellRunner = {
      ...noOpShell,
      exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
        calls.push({ command, args, cwd: options?.cwd });
        if (args[0] === 'remote') return 'git@github.com:Acme/Repo.git';
        if (args[0] === 'ls-remote' && args.includes('--symref')) {
          return 'ref: refs/heads/main\tHEAD\nabc\tHEAD\n';
        }
        throw new Error(`unexpected command ${command} ${args.join(' ')}`);
      }),
      execQuiet: vi.fn(async (command: string, args: string[], options?: { cwd?: string }) => {
        calls.push({ command, args, cwd: options?.cwd });
        return { stdout: 'def\trefs/heads/feature/ui\n', code: 0 };
      }),
    };

    const result = await resolveGitHubSource({
      repoRoot: '/repo',
      branch: 'feature/ui',
      env: { GH_TOKEN: token },
      shellRunner,
    });

    expect(result).toMatchObject({
      remote: expect.objectContaining({ canonical: 'github.com/acme/repo' }),
      defaultBranch: 'main',
      requestedBranch: 'feature/ui',
      requestedBranchExists: true,
      needsBranchSetup: false,
      source: {
        type: 'git',
        url: 'https://github.com/acme/repo.git',
        revision: 'feature/ui',
        username: 'x-access-token',
        password: token,
      },
    });
    expect(calls.every(({ args }) => !args.includes(token))).toBe(true);
    expect(calls.every(({ cwd }) => cwd === '/repo')).toBe(true);
    expect(calls.find(({ command, args }) => command === 'git' && args[0] === 'ls-remote' && args.includes('--heads'))?.args)
      .toEqual(['ls-remote', '--heads', 'https://github.com/acme/repo.git', '--', 'refs/heads/feature/ui']);
  });

  it('accepts case-insensitive HTTPS and SSH schemes', () => {
    expect(normalizeGitHubSourceRemote('HtTpS://github.com/acme/repo.git').url)
      .toBe('https://github.com/acme/repo.git');
    expect(normalizeGitHubSourceRemote('SsH://git@github.com/acme/repo.git').url)
      .toBe('https://github.com/acme/repo.git');
  });

  it('rejects non-canonical GitHub origins and unsafe branch names', () => {
    expect(() => normalizeGitHubSourceRemote('http://github.com/acme/repo.git')).toThrow(/HTTPS or SSH/i);
    expect(() => normalizeGitHubSourceRemote('https://user:password@github.com/acme/repo.git')).toThrow(/credentials/i);
    expect(() => normalizeGitHubSourceRemote('ssh://git:password@github.com/acme/repo.git')).toThrow(/credentials|password/i);
    expect(() => normalizeGitHubSourceRemote('ssh://user@github.com/acme/repo.git')).toThrow(/username|credentials|git/i);
    expect(() => normalizeGitHubSourceRemote('ssh://github.com/acme/repo.git')).toThrow(/username|credentials|git/i);
    expect(() => normalizeGitHubSourceRemote('git@github.com:acme/repo?ref=main')).toThrow(/reserved|query|origin/i);
    expect(() => normalizeGitHubSourceRemote('git@github.com:acme/repo#main')).toThrow(/reserved|fragment|origin/i);
    expect(() => normalizeGitHubSourceRemote('git@github.com:acme/re%70o')).toThrow(/reserved|origin/i);
    expect(() => normalizeGitHubRemote('https://user:password@github.com/acme/repo.git')).toThrow(/credentials/i);
    expect(() => normalizeGitHubSourceRemote('git@gitlab.com:acme/repo.git')).toThrow(/HTTPS or SSH|github.com/i);
    expect(() => selectGitHubRevision({
      requestedBranch: '-c',
      defaultBranch: 'main',
      requestedBranchExists: false,
    })).toThrow(/branch/i);
    for (const branch of ['feature/./x', '.hidden']) {
      expect(() => selectGitHubRevision({
        requestedBranch: branch,
        defaultBranch: 'main',
        requestedBranchExists: false,
      })).toThrow(/branch/i);
    }
  });

  it('uses the remote default and requests a post-create branch switch when missing', () => {
    expect(selectGitHubRevision({
      requestedBranch: 'feature/new',
      defaultBranch: 'main',
      requestedBranchExists: false,
    })).toEqual({
      revision: 'main',
      requestedBranch: 'feature/new',
      defaultBranch: 'main',
      needsBranchSetup: true,
    });
  });

  it('selects the requested remote revision when the branch exists', () => {
    expect(selectGitHubRevision({
      requestedBranch: 'feature/ui',
      defaultBranch: 'main',
      requestedBranchExists: true,
    })).toEqual({
      revision: 'feature/ui',
      requestedBranch: 'feature/ui',
      defaultBranch: 'main',
      needsBranchSetup: false,
    });
  });

  it('normalizes supported GitHub HTTPS and SSH origins to one SDK URL', () => {
    const https = normalizeGitHubSourceRemote('https://GitHub.com/Acme/Repo.git');
    const ssh = normalizeGitHubSourceRemote('git@github.com:acme/repo');

    expect(https).toEqual(ssh);
    expect(https).toMatchObject({
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      canonical: 'github.com/acme/repo',
      url: 'https://github.com/acme/repo.git',
    });
  });
});
