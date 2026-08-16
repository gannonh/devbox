import { describe, expect, it, vi } from 'vitest';
import { normalizeGitHubRemote } from '../src/providers/vercel/identity.js';
import {
  normalizeGitHubSourceRemote,
  resolveGitHubSource,
  resolveGitHubToken,
  selectGitHubRevision,
} from '../src/providers/vercel/source.js';

const noOpShell = {
  execQuiet: vi.fn(),
  spawnInherit: vi.fn(),
};

describe('Vercel GitHub source selection', () => {
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
