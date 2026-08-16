import { describe, expect, it, vi } from 'vitest';
import lockfile from 'proper-lockfile';
import { acquireMetadataLock } from '../src/providers/vercel/metadata-lock.js';

vi.mock('proper-lockfile', () => ({
  default: { lock: vi.fn() },
}));

describe('Vercel metadata lock retry timers', () => {
  it('keeps the lock retry timer referenced while a non-TTY operation waits', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => {});
    const lock = vi.mocked(lockfile.lock);
    lock.mockResolvedValue(release);

    try {
      const owner = await acquireMetadataLock('/tmp/metadata.json', '/tmp/metadata.lock', {
        timeoutMs: 100,
        retryMs: 10,
      });
      const options = lock.mock.calls[0][1] as {
        retries: { unref: boolean };
      };
      expect(options.retries.unref).toBe(false);
      await owner.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
