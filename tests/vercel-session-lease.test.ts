import { describe, expect, it } from 'vitest';
import {
  createVercelSessionLease,
  formatVercelSessionLease,
} from '../src/providers/vercel/session-lease.js';

describe('Vercel session lease', () => {
  it('reports configured duration, provider deadline, and remaining duration', () => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    const lease = createVercelSessionLease({
      configuredTimeoutMs: 60 * 60 * 1000,
      expiresAt: new Date('2026-08-30T12:59:30.000Z'),
    });

    expect(formatVercelSessionLease(lease, now)).toEqual([
      '  session duration: 60 minutes',
      '  session expires: 2026-08-30T12:59:30.000Z',
      '  session remaining: 59 minutes',
    ]);
  });

  it('reports only the configured duration when the provider omits expiresAt', () => {
    const lease = createVercelSessionLease({ configuredTimeoutMs: 45 * 60 * 1000 });

    expect(formatVercelSessionLease(lease)).toEqual([
      '  session duration: 45 minutes',
    ]);
  });
});
