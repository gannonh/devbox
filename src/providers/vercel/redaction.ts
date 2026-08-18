export const REDACTED_SECRET = '[REDACTED]';

export function addSecrets(secrets: string[], ...values: Array<string | undefined>): void {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && !secrets.includes(value)) secrets.push(value);
  }
}

/** Redact known secrets from text before it reaches errors, logs, or metadata. */
export function redactSecrets(value: unknown, secrets: readonly string[] = []): string {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : stringify(value);
  return [...new Set(secrets.flatMap(secret => [secret, encodeURIComponent(secret)]))]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => {
      return result.replaceAll(secret, REDACTED_SECRET);
    }, text);
}

function stringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

export function redactedError(error: unknown, secrets: readonly string[] = []): Error {
  const result = new Error(redactSecrets(error, secrets));
  if (error instanceof Error) result.name = error.name;
  return result;
}
