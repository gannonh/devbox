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
