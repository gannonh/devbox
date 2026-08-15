import { describe, expect, it } from 'vitest';
import {
  createVercelIdentity,
  normalizeGitHubRemote,
} from '../src/providers/vercel/identity.js';

describe('Vercel identity', () => {
  it('normalizes equivalent GitHub remotes to one canonical repository identity', () => {
    expect(normalizeGitHubRemote('https://GitHub.com/Acme/Repo.git')).toEqual(
      normalizeGitHubRemote('git@github.com:acme/repo'),
    );
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
});
