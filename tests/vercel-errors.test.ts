import { describe, expect, it } from 'vitest';
import { mapVercelError } from '../src/providers/vercel/errors.js';

describe('Vercel provider errors', () => {
  it('maps metadata lock contention before generic timeout with action recovery', () => {
    const attach = mapVercelError(Object.assign(new Error('metadata is busy'), { code: 'ELOCKED' }), {
      action: 'attach',
      branch: 'feature/ui',
    });
    expect(attach.code).toBe('locked');
    expect(attach.message).toContain('devbox --provider vercel feature/ui --attach');
    expect(attach.message).toContain('metadata lock');
    expect(attach.message).not.toContain('timed out');

    const stop = mapVercelError(new Error('Timed out waiting for Vercel metadata lock: /tmp/vercel.lock'), {
      action: 'stop',
      branch: 'feature/ui',
    });
    expect(stop.code).toBe('locked');
    expect(stop.message).toContain('devbox --provider vercel feature/ui --stop');
  });

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
      ['auth', new Error(`Missing Vercel credential(s): ${token}; explicit triad is incomplete`)],
      ['scope_link', new Error(`Malformed Vercel project link: linked project.json is malformed ${token}`)],
      ['confirmation', new Error(`Vercel scope confirmation requires a TTY ${token}`)],
      ['private_repo', Object.assign(new Error(`GitHub source access failed ${token}`), { status: 403, operation: 'source' })],
      ['source', Object.assign(new Error(`source probe failed ${token}`), { code: 'github_source_resolution_failed' })],
      ['auth', Object.assign(new Error(`Vercel API ${token}`), { status: 403 })],
      ['missing', Object.assign(new Error(`resource ${token} not found`), { status: 404 })],
      ['stale', Object.assign(new Error(`resource ${token} gone`), { status: 410 })],
      ['identity', Object.assign(new Error(`identity conflict ${token}`), { status: 409 })],
      ['image_not_ready', Object.assign(new Error(`image readiness failed ${token}`), { code: 'image_not_ready' })],
      ['timeout', Object.assign(new Error(`request failed ${token}`), { name: 'TimeoutError' })],
      ['aborted', Object.assign(new Error(`request failed ${token}`), { name: 'AbortError' })],
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

  it('classifies the exact stored scope mismatch as scope and gives safe ambiguous recovery guidance', () => {
    const scope = mapVercelError(new Error('Stored Vercel team/project does not match resolved credentials'), {
      action: 'attach',
      branch: 'feature/ui',
    });
    expect(scope.code).toBe('scope');

    const ambiguous = mapVercelError(new Error('Multiple live Vercel sandboxes match github.com/acme/repo branch feature/ui'), {
      action: 'remove',
      branch: 'feature/ui',
    });
    expect(ambiguous.code).toBe('identity');
    expect(ambiguous.message).toMatch(/Vercel console|manual/i);
    expect(ambiguous.message).not.toContain('--rm');
  });

  it('only classifies exact scope confirmation phrases', () => {
    expect(mapVercelError(new Error('terminal transport mentioned tty'), {
      action: 'attach',
      branch: 'feature/ui',
    }).code).toBe('api');
    expect(mapVercelError(new Error('Vercel scope confirmation requires a TTY'), {
      action: 'up',
      branch: 'feature/ui',
    }).code).toBe('confirmation');
    expect(mapVercelError(new Error('Vercel scope confirmation was refused'), {
      action: 'up',
      branch: 'feature/ui',
    }).code).toBe('confirmation');
    expect(mapVercelError(new Error('confirmation requires a TTY'), {
      action: 'up',
      branch: 'feature/ui',
    }).code).toBe('api');
  });

  it('leaves generic lookalike text in the API category', () => {
    for (const message of [
      'operation undergone unexpectedly',
      'preparing credentials',
      'clone configuration failed',
      'private network unavailable',
      'file not found in configuration',
      'resource gone',
      'sandbox stale',
      'request timed out in a payload field',
      'image is preparing',
    ]) {
      expect(mapVercelError(new Error(message), { action: 'attach', branch: 'feature/ui' }).code, message)
        .toBe('api');
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
