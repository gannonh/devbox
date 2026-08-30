import { ProviderOperationError } from '../types.js';
import { VercelSdkError } from './client.js';
import { VercelDisplayStartupError } from './display-startup.js';
import {
  VercelCleanupError,
  VercelCreationCompensationError,
  VercelRecoveryCleanupError,
  VercelIdentityConflictError,
  VercelResourceNotFoundError,
  VercelRouteNotFoundError,
  VercelScopeConflictError,
} from './lifecycle.js';
import { VercelObsoleteMetadataError } from './metadata-schema.js';
import { redactSecrets } from './redaction.js';

export type VercelProviderErrorCode =
  | 'auth'
  | 'scope'
  | 'scope_link'
  | 'confirmation'
  | 'private_repo'
  | 'source'
  | 'missing'
  | 'stale'
  | 'identity'
  | 'quota'
  | 'image_not_ready'
  | 'locked'
  | 'timeout'
  | 'aborted'
  | 'cleanup'
  | 'route'
  | 'display'
  | 'api';

export interface VercelErrorContext {
  action?: string;
  operation?: 'source' | 'terminal' | 'api';
  branch?: string;
  requestedTimeoutMs?: number;
  secrets?: readonly string[];
}

/** Captured from a live Sandbox create probe with a timeout above one day. */
export const VERCEL_LONG_SESSION_REJECTION_SIGNATURE = 'status code 400 is not ok: `timeout` should be <= 1d';

/** A stable, redacted error exposed by the provider boundary. */
export class VercelProviderError extends ProviderOperationError {
  readonly code: VercelProviderErrorCode;

  constructor(code: VercelProviderErrorCode, message: string, exitCode = 1) {
    super(message, exitCode);
    this.name = 'VercelProviderError';
    this.code = code;
  }
}

/** Map SDK, source, auth, and lifecycle failures to concise CLI errors. */
export function mapVercelError(
  error: unknown,
  context: VercelErrorContext = {},
): VercelProviderError {
  if (error instanceof VercelProviderError) {
    return new VercelProviderError(
      error.code,
      redactSecrets(error.message, context.secrets ?? []),
      error.exitCode,
    );
  }

  const status = statusOf(error);
  const lifecycleCode = codeOf(error);
  const operation = operationOf(error) ?? context.operation;
  const detail = safeDetail(error, context.secrets ?? []);
  const command = recoveryCommand(context);
  const message = detail.toLowerCase();

  if (error instanceof VercelObsoleteMetadataError || lifecycleCode === 'obsolete_metadata') {
    return new VercelProviderError(
      'stale',
      `Stored Vercel metadata contains the removed idle policy; run ${removeRecoveryCommand(context)}, then create the box again with ${createRecoveryCommand(context)}.`,
    );
  }

  if (isMetadataLockContention(error, message)) {
    return new VercelProviderError(
      'locked',
      `Vercel metadata lock is held by another operation; wait for it to finish, then retry ${command}.`,
      2,
    );
  }
  if (error instanceof VercelRouteNotFoundError || lifecycleCode === 'route_not_found') {
    const noVnc = detail.toLowerCase().includes('authenticated novnc');
    return new VercelProviderError(
      'route',
      noVnc
        ? `Authenticated noVNC route (port 6080) is unavailable; start the box and retry ${command}.`
        : `No Vercel route is available for this sandbox; start it and expose a configured port, then retry ${command}.`,
      2,
    );
  }
  if (error instanceof VercelDisplayStartupError || lifecycleCode === 'display_startup_failed') {
    return new VercelProviderError(
      'display',
      `Vercel display startup failed: ${detail || 'one or more display services are not running'}; `
        + `the box was left running; inspect the display services and retry ${command}.`,
    );
  }
  if (error instanceof VercelCreationCompensationError) {
    const residualIds = [
      ...error.result.residualSandboxIds,
      ...error.result.residualSnapshotIds,
    ];
    const residualDetail = residualIds.length > 0
      ? ` Recover or inspect resource IDs: ${residualIds.join(', ')}.`
      : '';
    const metadataDetail = error.recoveryMetadataFailure === undefined
      ? ' Inspect the retained recovery metadata.'
      : ` recovery metadata was not retained: ${error.recoveryMetadataFailure}.`;
    return new VercelProviderError(
      'cleanup',
      `Vercel Sandbox creation failed and cleanup is incomplete; retry ${removeRecoveryCommand(context)}.${residualDetail}${metadataDetail}`,
    );
  }
  if (error instanceof VercelRecoveryCleanupError) {
    return new VercelProviderError(
      'cleanup',
      `${redactSecrets(error.message, context.secrets ?? [])} Retry ${removeRecoveryCommand(context)}.`,
    );
  }
  if (error instanceof VercelCleanupError || lifecycleCode === 'cleanup_incomplete' || lifecycleCode === 'stop_incomplete') {
    return new VercelProviderError(
      'cleanup',
      `Vercel cleanup is incomplete; retry ${removeRecoveryCommand(context)} and inspect the retained recovery metadata.`,
    );
  }
  if (error instanceof VercelResourceNotFoundError || lifecycleCode === 'resource_not_found') {
    // `command` is the action that just failed; --attach and --stop do not
    // create anything, so point at the boot command instead of looping the
    // user back onto the command they just ran.
    return new VercelProviderError(
      'missing',
      `No matching Vercel sandbox was found for branch '${context.branch ?? '<branch>'}';`
      + ` run ${createRecoveryCommand(context)} to create it.`,
    );
  }
  if (lifecycleCode === 'stale') {
    return new VercelProviderError(
      'stale',
      `The stored Vercel sandbox is stale; retry ${removeRecoveryCommand(context)}, then create it again.`,
    );
  }
  if (isAmbiguousIdentityError(message)) {
    return new VercelProviderError(
      'identity',
      'Multiple live Vercel sandboxes match this repository and branch; do not run automatic removal. Resolve the duplicate in the Vercel console or manually identify and remove only the exact resource, then retry.',
      2,
    );
  }
  if (error instanceof VercelIdentityConflictError || lifecycleCode === 'identity_conflict') {
    return new VercelProviderError(
      'identity',
      `The Vercel sandbox identity conflicts with this repository or branch; remove the stale box with ${removeRecoveryCommand(context)} and retry.`,
      2,
    );
  }
  if (error instanceof VercelScopeConflictError || lifecycleCode === 'scope_conflict' || isStoredScopeMismatch(message)) {
    return new VercelProviderError(
      'scope',
      `The stored Vercel team/project scope conflicts with this request; use the stored scope or remove its box with ${removeRecoveryCommand(context)}.`,
      2,
    );
  }
  if (isConfirmationError(message)) {
    return new VercelProviderError(
      'confirmation',
      `Vercel team/project confirmation is required in a TTY; rerun ${command} interactively and confirm the displayed scope.`,
      2,
    );
  }
  if (isScopeLinkError(message, lifecycleCode)) {
    return new VercelProviderError(
      'scope_link',
      `Vercel project scope is missing or malformed; run "vercel link" in the repository or set a complete VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID triad, then retry ${command}.`,
      2,
    );
  }
  if (isPartialCredentialError(message) || lifecycleCode === 'invalid_vercel_oidc_token' || isInvalidOidcTokenError(message)) {
    return new VercelProviderError(
      'auth',
      `Vercel credentials are incomplete; set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together, then retry ${command}.`,
      2,
    );
  }
  if (lifecycleCode === 'branch_setup_failed' || isPrivateRepoError(status, operation, lifecycleCode)) {
    return new VercelProviderError(
      'private_repo',
      `GitHub source access failed; ensure the origin is a GitHub remote and GH_TOKEN, GITHUB_TOKEN, or "gh auth token" can read the private repository, then retry ${recoveryCommand(context)}.`,
      2,
    );
  }
  if (isSourceError(operation, lifecycleCode)) {
    return new VercelProviderError(
      'source',
      `GitHub source resolution failed; use a canonical GitHub origin and verify the default/requested branch, then retry ${recoveryCommand(context)}.`,
      2,
    );
  }
  if (status === 401 || status === 403 || isStableCode(lifecycleCode, ['unauthorized', 'forbidden', 'auth_failed'])) {
    return new VercelProviderError(
      'auth',
      `Vercel authentication or authorization failed; set valid VERCEL_TOKEN credentials for the displayed team/project and retry ${command}.`,
    );
  }
  if (status === 404 || error instanceof VercelResourceNotFoundError || lifecycleCode === 'resource_not_found') {
    return new VercelProviderError(
      'missing',
      `The requested Vercel sandbox or resource was not found; run ${command} to recover or recreate it.`,
    );
  }
  if (status === 410 || lifecycleCode === 'stale') {
    return new VercelProviderError(
      'stale',
      `The Vercel sandbox resource is stale; retry ${removeRecoveryCommand(context)}, then create it again.`
    );
  }
  if (status === 409 || lifecycleCode === 'identity_conflict') {
    return new VercelProviderError(
      'identity',
      `The Vercel sandbox identity conflicts with an existing resource; remove the stale box with ${removeRecoveryCommand(context)} and retry.`,
      2,
    );
  }
  if (status === 429 || isStableCode(lifecycleCode, ['quota', 'rate_limit'])) {
    const retryAfter = retryAfterOf(error);
    const retry = retryAfter === undefined ? 'retry later' : `retry after ${retryAfter}`;
    return new VercelProviderError(
      'quota',
      `Vercel quota or rate limit reached; ${retry} and run ${command}.`,
    );
  }
  if (lifecycleCode === 'image_not_ready') {
    return new VercelProviderError(
      'image_not_ready',
      `The pinned Vercel image is not ready; wait for image readiness and retry ${command}.`,
    );
  }
  if (isAbortError(error, message, lifecycleCode)) {
    return new VercelProviderError('aborted', 'The Vercel operation was aborted; retry the command.');
  }
  if (isTimeoutError(error, message, lifecycleCode)) {
    return new VercelProviderError(
      'timeout',
      `The Vercel operation timed out; check network/authentication and retry ${command}.`,
    );
  }
  if (lifecycleCode === 'metadata_incomplete') {
    return new VercelProviderError(
      'source',
      `GitHub source metadata is incomplete; recreate the branch sandbox with ${recoveryCommand({ ...context, action: 'up' })}.`,
      2,
    );
  }

  const suffix = detail ? `: ${detail}` : '';
  const durationHint = isLongSessionCreate(context, operation, status, message)
    ? `; requested timeout: ${Math.round(context.requestedTimeoutMs! / 60_000)} minutes. Vercel Hobby supports up to 45 minutes; Pro and Enterprise support up to 24 hours. Try --timeout 45.`
    : '';
  return new VercelProviderError(
    'api',
    `Vercel API request failed${suffix}${durationHint}; check credentials and network access, then retry ${command}.`,
  );
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof VercelSdkError) return error.status;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  } | null;
  if (typeof candidate?.status === 'number') return candidate.status;
  if (typeof candidate?.response?.status === 'number') return candidate.response.status;
  return undefined;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function safeDetail(error: unknown, secrets: readonly string[]): string {
  return redactSecrets(error, secrets).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function recoveryCommand(context: VercelErrorContext): string {
  const action = context.action;
  if (action === 'list') return 'devbox --provider vercel --list';
  const branch = context.branch ?? '<branch>';
  const base = `devbox --provider vercel ${branch}`;
  switch (action) {
    case 'attach': return `${base} --attach`;
    case 'stop': return `${base} --stop`;
    case 'remove': return `${base} --rm`;
    case 'url': return `${base} --url`;
    case 'up': return base;
    default: return base;
  }
}

/** The command that actually creates a box, whatever action failed. */
function createRecoveryCommand(context: VercelErrorContext): string {
  if (context.action === 'list') return 'devbox --provider vercel --list';
  return `devbox --provider vercel ${context.branch ?? '<branch>'}`;
}

function removeRecoveryCommand(context: VercelErrorContext): string {
  if (context.action === 'list') return 'devbox --provider vercel --list';
  const branch = context.branch ?? '<branch>';
  return `devbox --provider vercel ${branch} --rm`;
}

function isConfirmationError(message: string): boolean {
  return [
    /^vercel scope confirmation requires a tty(?: \[redacted\])?$/,
    /^vercel scope confirmation was refused(?: \[redacted\])?$/,
  ].some((pattern) => pattern.test(message));
}

function isMetadataLockContention(error: unknown, message: string): boolean {
  return codeOf(error) === 'ELOCKED'
    || /^timed out waiting for vercel metadata lock: .+$/.test(message);
}

function isLongSessionCreate(
  context: VercelErrorContext,
  operation: string | undefined,
  status: number | undefined,
  message: string,
): boolean {
  return context.action === 'up'
    && operation === 'Sandbox.getOrCreate'
    && context.requestedTimeoutMs !== undefined
    && context.requestedTimeoutMs > 45 * 60_000
    && (status === 400 || status === 422)
    && message === VERCEL_LONG_SESSION_REJECTION_SIGNATURE;
}

function isScopeLinkError(message: string, code: string | undefined): boolean {
  return code === 'scope_link'
    || /^vercel project link is missing: .+$/.test(message)
    || /^vercel project link must (?:be a regular file|not be a symbolic link|not be group\/world writable): .+$/.test(message)
    || /^malformed vercel project link: .+$/.test(message);
}

function isPartialCredentialError(message: string): boolean {
  return /^missing vercel credential\(s\): .+; explicit triad is incomplete$/.test(message);
}

function isInvalidOidcTokenError(message: string): boolean {
  return /^invalid vercel oidc token: .+$/.test(message);
}

function isPrivateRepoError(
  status: number | undefined,
  operation: string | undefined,
  code: string | undefined,
): boolean {
  return code === 'github_source_access_denied'
    || code === 'github_credentials_unavailable'
    || (operation === 'source' && (status === 401 || status === 403));
}

function isSourceError(operation: string | undefined, code: string | undefined): boolean {
  return operation === 'source' || (code?.startsWith('github_') ?? false);
}

function isAmbiguousIdentityError(message: string): boolean {
  return /^multiple live vercel sandboxes match .+$/.test(message);
}

function isStoredScopeMismatch(message: string): boolean {
  return message === 'stored vercel team/project does not match resolved credentials';
}

function isAbortError(error: unknown, message: string, code: string | undefined): boolean {
  return (error instanceof Error && error.name === 'AbortError')
    || code === 'ABORT_ERR'
    || /^vercel (?:authentication|operation) aborted$/.test(message);
}

function isTimeoutError(error: unknown, message: string, code: string | undefined): boolean {
  return (error instanceof Error && error.name === 'TimeoutError')
    || code === 'ETIMEDOUT'
    || /^vercel (?:authentication|operation) timed out$/.test(message);
}

function operationOf(error: unknown): string | undefined {
  const candidate = error as { operation?: unknown } | null;
  return typeof candidate?.operation === 'string' ? candidate.operation : undefined;
}

function isStableCode(code: string | undefined, expected: readonly string[]): boolean {
  return code !== undefined && expected.includes(code);
}

function retryAfterOf(error: unknown): string | undefined {
  const candidate = error as {
    retryAfter?: unknown;
    response?: { headers?: Headers | Record<string, unknown> };
    headers?: Headers | Record<string, unknown>;
  } | null;
  if (typeof candidate?.retryAfter === 'string' || typeof candidate?.retryAfter === 'number') {
    return String(candidate.retryAfter);
  }
  for (const headers of [candidate?.response?.headers, candidate?.headers]) {
    if (!headers) continue;
    if (headers instanceof Headers) {
      const value = headers.get('retry-after');
      if (value) return value;
    } else {
      const value = headers['retry-after'] ?? headers['Retry-After'];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  }
  return undefined;
}
