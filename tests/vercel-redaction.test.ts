import { describe, expect, it } from 'vitest';
import { REDACTED_SECRET, redactSecrets, redactedError } from '../src/providers/vercel/redaction.js';

describe('Vercel secret redaction', () => {
  it('redacts raw, URL-encoded, and basic-auth-like token occurrences', () => {
    const token = 'pa:ss/@word';
    const encoded = encodeURIComponent(token);
    const rendered = [
      `raw=${token}`,
      `url=https://user:${encoded}@github.com/acme/repo.git`,
      `basic=https://user:${token}@github.com/acme/repo.git`,
    ].join(' ');

    const redacted = redactSecrets(rendered, [token]);

    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain(encoded);
    expect(redacted.match(new RegExp(`\\${REDACTED_SECRET}`, 'g'))).toHaveLength(3);
  });

  it('redacts secrets from errors without exposing their rendered URL form', () => {
    const token = 'token/with?reserved';
    const error = redactedError(
      new Error(`request failed for https://x:${encodeURIComponent(token)}@example.test`),
      [token],
    );

    expect(error.message).toBe('request failed for https://x:[REDACTED]@example.test');
    expect(error.message).not.toContain(encodeURIComponent(token));
  });
});
