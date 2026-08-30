/**
 * Provider-owned session identity and lease policy.
 *
 * The Sandbox API may omit an absolute expiry. Keep that absence explicit so
 * output never invents a deadline from the configured duration.
 */

export type VercelSessionId = string & { readonly __vercelSessionId: unique symbol };

export type VercelSessionDeadline =
  | { kind: 'reported'; expiresAt: Date }
  | { kind: 'unreported' };

export interface VercelSessionLease {
  configuredTimeoutMs: number;
  deadline: VercelSessionDeadline;
}

export interface VercelSessionLeaseOptions {
  configuredTimeoutMs: number;
  expiresAt?: Date;
}

export function parseVercelSessionId(value: unknown): VercelSessionId | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value as VercelSessionId;
}

export function currentVercelSessionId(
  sandbox: { currentSession?: () => { readonly sessionId?: unknown } },
): VercelSessionId | null {
  return parseVercelSessionId(sandbox.currentSession?.()?.sessionId);
}

export function createVercelSessionLease(
  options: VercelSessionLeaseOptions,
): VercelSessionLease {
  if (!Number.isFinite(options.configuredTimeoutMs) || options.configuredTimeoutMs <= 0) {
    throw new TypeError('Vercel session timeout must be positive');
  }
  const time = options.expiresAt?.getTime();
  const deadline = time !== undefined && Number.isFinite(time)
    ? { kind: 'reported' as const, expiresAt: new Date(time) }
    : { kind: 'unreported' as const };
  return {
    configuredTimeoutMs: options.configuredTimeoutMs,
    deadline,
  };
}

export function formatVercelSessionLease(
  lease: VercelSessionLease,
  now = new Date(),
): string[] {
  const lines = [`  session duration: ${formatMinutes(lease.configuredTimeoutMs)} minutes`];
  if (lease.deadline.kind !== 'reported') return lines;
  lines.push(`  session expires: ${lease.deadline.expiresAt.toISOString()}`);
  const remainingMs = Math.max(0, lease.deadline.expiresAt.getTime() - now.getTime());
  lines.push(`  session remaining: ${formatMinutes(remainingMs)} minutes`);
  return lines;
}

function formatMinutes(milliseconds: number): number {
  return Math.max(0, Math.floor(milliseconds / 60_000));
}
