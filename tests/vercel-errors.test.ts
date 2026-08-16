import { describe, expect, it } from 'vitest';
import { mapVercelError } from '../src/providers/vercel/errors.js';

describe('Vercel provider errors', () => {
  it('maps rate limits with Retry-After without exposing the response body', () => {
    const token = 'rate-limit-token';
    const mapped = mapVercelError(Object.assign(new Error(`body ${token}`), {
      status: 429,
      headers: { 'retry-after': '12' },
    }), { branch: 'feature/ui', secrets: [token] });

    expect(mapped.code).toBe('quota');
    expect(mapped.message).toContain('retry after 12');
    expect(mapped.message).not.toContain(token);
  });

  it('classifies every required failure category before generic API handling', () => {
    const token = 'category-secret-token';
    const encoded = encodeURIComponent(token);
    const cases = [
      ['auth', new Error(`Missing Vercel credential(s): ${token}`)],
      ['scope_link', new Error(`linked project.json is malformed ${token}`)],
      ['confirmation', new Error(`confirmation requires a TTY ${token}`)],
      ['private_repo', Object.assign(new Error(`failed to clone private GitHub repository ${token}`), { status: 401 })],
      ['source', new Error(`Unable to resolve GitHub source branches: ls-remote ${token}`)],
      ['auth', Object.assign(new Error(`Vercel API ${token}`), { status: 403 })],
      ['missing', Object.assign(new Error(`resource ${token} not found`), { status: 404 })],
      ['stale', Object.assign(new Error(`resource ${token} gone`), { status: 410 })],
      ['identity', Object.assign(new Error(`identity conflict ${token}`), { status: 409 })],
      ['image_not_ready', new Error(`image is preparing ${token}`)],
      ['timeout', new Error(`request timed out ${token}`)],
      ['aborted', Object.assign(new Error(`request ${token}`), { name: 'AbortError' })],
      ['cleanup', Object.assign(new Error(`residual ${token}`), { code: 'cleanup_incomplete' })],
      ['route', Object.assign(new Error(`route ${token}`), { code: 'route_not_found' })],
      ['api', new Error(`unexpected response ${token}`)],
    ] as const;

    for (const [code, error] of cases) {
      const mapped = mapVercelError(error, {
        action: 'attach',
        branch: 'feature/ui',
        secrets: [token],
      });
      expect(mapped.code, error.message).toBe(code);
      expect(mapped.message).not.toContain(token);
      expect(mapped.message).not.toContain(encoded);
    }
  });

  it('uses action-specific recovery commands without a fake branch for list', () => {
    const actions = [
      ['list', undefined, '--list'],
      ['up', 'feature/ui', 'feature/ui'],
      ['attach', 'feature/ui', '--attach'],
      ['stop', 'feature/ui', '--stop'],
      ['remove', 'feature/ui', '--rm'],
      ['url', 'feature/ui', '--url'],
      ['password', 'feature/ui', '--password'],
    ] as const;
    for (const [action, branch, expected] of actions) {
      const mapped = mapVercelError(new Error('generic failure'), {
        action,
        ...(branch === undefined ? {} : { branch }),
      });
      expect(mapped.message).toContain(expected);
      if (action === 'list') expect(mapped.message).not.toContain('<branch>');
    }
    const listCleanup = mapVercelError(Object.assign(new Error('residual'), { code: 'cleanup_incomplete' }), {
      action: 'list',
    });
    expect(listCleanup.message).toContain('--list');
    expect(listCleanup.message).not.toContain('<branch>');
  });

  it('maps unauthorized SDK failures to a stable redacted recovery error', () => {
    const token = 'vercel-secret-token';
    const error = Object.assign(
      new Error(`request failed for https://vercel.com/api?token=${encodeURIComponent(token)}`),
      { status: 401 },
    );

    const mapped = mapVercelError(error, {
      action: 'attach',
      branch: 'feature/ui',
      secrets: [token],
    });

    expect(mapped.code).toBe('auth');
    expect(mapped.exitCode).not.toBe(0);
    expect(mapped.message).toContain('VERCEL_TOKEN');
    expect(mapped.message).not.toContain(token);
    expect(mapped.message).not.toContain(encodeURIComponent(token));
  });
});
