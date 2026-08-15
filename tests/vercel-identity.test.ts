import { describe, expect, it } from 'vitest';
import {
  createVercelIdentity,
  normalizeBranch,
  normalizeGitHubRemote,
  sanitizeVercelName,
} from '../src/providers/vercel/identity.js';

describe('Vercel identity', () => {
  it('normalizes equivalent GitHub remotes to one canonical repository identity', () => {
    expect(normalizeGitHubRemote('https://GitHub.com/Acme/Repo.git')).toEqual(
      normalizeGitHubRemote('git@github.com:acme/repo'),
    );
  });

  it('rejects invalid public identity inputs', () => {
    expect(() => normalizeGitHubRemote('not-a-github-remote')).toThrow(/invalid|exactly.*owner/i);
    expect(() => normalizeGitHubRemote('')).toThrow(/must not be empty/i);
    expect(() => normalizeBranch('')).toThrow(/non-empty printable/i);
    expect(() => normalizeBranch('feature\u0000branch')).toThrow(/non-empty printable/i);
    expect(() => sanitizeVercelName('name', 0)).toThrow(/maxLength.*positive/i);
  });

  it('creates deterministic conservative names and no more than five SDK tags', () => {
    const first = createVercelIdentity({
      remote: 'git@github.com:Acme/Repo.git',
      branch: 'feature/ui',
      packageVersion: '1.2.3',
    });
    const second = createVercelIdentity({
      remote: 'https://github.com/acme/repo',
      branch: 'feature/ui',
      packageVersion: '1.2.3',
    });

    expect(first).toEqual(second);
    expect(first.name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(first.name.length).toBeLessThanOrEqual(63);
    expect(Object.keys(first.tags)).toHaveLength(5);
    expect(first.tags.identity).toMatch(/^[a-f0-9]{16}$/);
    expect(Object.values(first.tags).every((tag) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tag))).toBe(true);
  });

  it('does not collide when sanitized repository or branch slugs would match', () => {
    const baseline = createVercelIdentity({
      remote: 'https://github.com/acme/repo-a',
      branch: 'feature/ui',
      packageVersion: '1.2.3',
    });
    const variants = [
      createVercelIdentity({ remote: 'https://github.com/other/repo-a', branch: 'feature/ui', packageVersion: '1.2.3' }),
      createVercelIdentity({ remote: 'https://git.example.com/acme/repo-a', branch: 'feature/ui', packageVersion: '1.2.3' }),
      createVercelIdentity({ remote: 'https://github.com/acme/repo-a', branch: 'feature-ui', packageVersion: '1.2.3' }),
      createVercelIdentity({ remote: 'https://github.com/acme/repo-a', branch: 'feature/ui', packageVersion: '1.2.4' }),
    ];

    for (const variant of variants) {
      expect(variant.name).not.toBe(baseline.name);
      expect(variant.tags.identity).not.toBe(baseline.tags.identity);
      expect(variant.tags).not.toEqual(baseline.tags);
    }
  });

  it('honors every positive name length and hashes long shared prefixes', () => {
    for (const maxLength of [1, 2, 3, 7, 31, 63]) {
      const sanitized = sanitizeVercelName('A name with punctuation and a long suffix', maxLength);
      expect(sanitized.length).toBeLessThanOrEqual(maxLength);
      expect(sanitized).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    }

    const shared = 'shared-prefix-'.repeat(12);
    const first = createVercelIdentity({
      remote: `https://github.com/${shared}owner/${shared}repo-a`,
      branch: `${shared}branch-a`,
      packageVersion: '1.2.3',
    });
    const second = createVercelIdentity({
      remote: `https://github.com/${shared}owner/${shared}repo-b`,
      branch: `${shared}branch-b`,
      packageVersion: '1.2.3',
    });

    expect(first.name).not.toBe(second.name);
    expect(first.tags.identity).not.toBe(second.tags.identity);
  });
});
