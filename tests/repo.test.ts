import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot, repoName } from '../src/lib/repo.js';

describe('findRepoRoot', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'devbox-repo-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the directory containing .git when .git is at the start dir', async () => {
    // Simulate a git repo: create .git in tempDir
    await mkdir(join(tempDir, '.git'));
    expect(findRepoRoot(tempDir)).toBe(tempDir);
  });

  it('walks up to find .git in a parent directory', async () => {
    // Simulate a git repo with a nested subdir
    await mkdir(join(tempDir, '.git'));
    const nested = join(tempDir, 'packages', 'server', 'src');
    await mkdir(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(tempDir);
  });

  it('walks up multiple levels to find .git', async () => {
    await mkdir(join(tempDir, '.git'));
    const deep = join(tempDir, 'a', 'b', 'c', 'd');
    await mkdir(deep, { recursive: true });

    expect(findRepoRoot(deep)).toBe(tempDir);
  });

  it('returns null when no .git is found in any ancestor', async () => {
    // tempDir has no .git, and its ancestors (os.tmpdir()) don't either.
    // Use a subdirectory so we don't walk too far up into system dirs that
    // might have .git (e.g. /Volumes/EVO/dev/devbox/.git).
    const subdir = join(tempDir, 'no-git-here');
    await mkdir(subdir);
    // findRepoRoot walks up from subdir. If it reaches the filesystem root
    // without finding .git, it returns null. On most systems /tmp (or its
    // canonical equivalent) won't have .git, but to be safe we accept either
    // null or a path that contains our tempDir (in case a system .git exists
    // above tmpdir on this machine).
    const result = findRepoRoot(subdir);
    if (result === null) {
      // expected: no .git found
    } else {
      // If a .git exists above tmpdir on this machine, the result should NOT
      // be our tempDir (which has no .git).
      expect(result).not.toBe(tempDir);
      expect(result).not.toBe(subdir);
    }
  });
});

describe('repoName', () => {
  it('returns the basename of a path', () => {
    expect(repoName('/Volumes/EVO/dev/my-repo')).toBe('my-repo');
  });

  it('returns the basename for a nested path', () => {
    expect(repoName('/home/user/projects/kata-agents')).toBe('kata-agents');
  });

  it('returns the basename for a trailing-slash path', () => {
    // basename handles trailing slashes correctly
    expect(repoName('/Volumes/EVO/dev/my-repo/')).toBe('my-repo');
  });

  it('returns empty string for root (Node basename behavior)', () => {
    // Node's basename('/') returns '' — an edge case that never occurs in
    // practice (a repo root is never '/'), but we document the behavior.
    expect(repoName('/')).toBe('');
  });
});
