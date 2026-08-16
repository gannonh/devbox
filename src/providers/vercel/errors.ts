import { ProviderOperationError } from '../types.js';
import { VercelSdkError } from './client.js';
import {
  VercelCleanupError,
  VercelIdentityConflictError,
  VercelResourceNotFoundError,
  VercelRouteNotFoundError,
  VercelScopeConflictError,
} from './lifecycle.js';
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
  | 'api';

export interface VercelErrorContext {
  action?: string;
  operation?: 'source' | 'terminal' | 'api';
  branch?: string;
  secrets?: readonly string[];
}

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
  const detail = safeDetail(error, context.secrets ?? []);
  const command = recoveryCommand(context);
  const message = detail.toLowerCase();

  if (isMetadataLockContention(error, message)) {
    return new VercelProviderError(
      'locked',
      `Vercel metadata lock is held by another operation; wait for it to finish, then retry ${command}.`,
      2,
    );
  }
  if (error instanceof VercelRouteNotFoundError || lifecycleCode === 'route_not_found') {
    return new VercelProviderError(
      'route',
      `No Vercel route is available for this sandbox; start it and expose a configured port, then retry ${command}.`,
      2,
    );
  }
  if (error instanceof VercelCleanupError || lifecycleCode === 'cleanup_incomplete' || lifecycleCode === 'stop_incomplete') {
    return new VercelProviderError(
      'cleanup',
      `Vercel cleanup is incomplete; retry ${removeRecoveryCommand(context)} and inspect the retained recovery metadata.`,
    );
  }
  if (error instanceof VercelResourceNotFoundError || lifecycleCode === 'resource_not_found') {
    return new VercelProviderError(
      'missing',
      `No matching Vercel sandbox was found; run ${command} to create it again.`,
    );
  }
  if (lifecycleCode === 'stale') {
    return new VercelProviderError(
      'stale',
      `The stored Vercel sandbox is stale; retry ${removeRecoveryCommand(context)}, then create it again.`,
    );
  }
  if (error instanceof VercelIdentityConflictError || lifecycleCode === 'identity_conflict') {
    return new VercelProviderError(
      'identity',
      `The Vercel sandbox identity conflicts with this repository or branch; remove the stale box with ${removeRecoveryCommand(context)} and retry.`,
      2,
    );
  }
  if (error instanceof VercelScopeConflictError || lifecycleCode === 'scope_conflict' || message.includes('scope conflict') || message.includes('stored vercel team/project')) {
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
  if (isScopeLinkError(message)) {
    return new VercelProviderError(
      'scope_link',
      `Vercel project scope is missing or malformed; run "vercel link" in the repository or set a complete VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID triad, then retry ${command}.`,
      2,
    );
  }
  if (isPartialCredentialError(message) || message.includes('invalid vercel oidc token')) {
    return new VercelProviderError(
      'auth',
      `Vercel credentials are incomplete; set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together, then retry ${command}.`,
      2,
    );
  }
  if (lifecycleCode === 'branch_setup_failed' || isPrivateRepoError(message)) {
    return new VercelProviderError(
      'private_repo',
      `GitHub source access failed; ensure the origin is a GitHub remote and GH_TOKEN, GITHUB_TOKEN, or "gh auth token" can read the private repository, then retry ${recoveryCommand(context)}.`,
      2,
    );
  }
  if (isSourceError(message)) {
    return new VercelProviderError(
      'source',
      `GitHub source resolution failed; use a canonical GitHub origin and verify the default/requested branch, then retry ${recoveryCommand(context)}.`,
      2,
    );
  }
  if (status === 401 || status === 403 || /\b(?:401|403)\b|unauthori[sz]ed|forbidden/.test(message)) {
    return new VercelProviderError(
      'auth',
      `Vercel authentication or authorization failed; set valid VERCEL_TOKEN credentials for the displayed team/project and retry ${command}.`,
    );
  }
  if (status === 404 || error instanceof VercelResourceNotFoundError || /\b404\b|not found/.test(message)) {
    return new VercelProviderError(
      'missing',
      `The requested Vercel sandbox or resource was not found; run ${command} to recover or recreate it.`,
    );
  }
  if (status === 410 || /\b410\b|stale|gone/.test(message)) {
    return new VercelProviderError(
      'stale',
      `The Vercel sandbox resource is stale; retry ${removeRecoveryCommand(context)}, then create it again.`
    );
  }
  if (status === 409 || /\b409\b|identity conflict|already exists/.test(message)) {
    return new VercelProviderError(
      'identity',
      `The Vercel sandbox identity conflicts with an existing resource; remove the stale box with ${removeRecoveryCommand(context)} and retry.`,
      2,
    );
  }
  if (status === 429 || /\b429\b|rate limit|quota/.test(message)) {
    const retryAfter = retryAfterOf(error);
    const retry = retryAfter === undefined ? 'retry later' : `retry after ${retryAfter}`;
    return new VercelProviderError(
      'quota',
      `Vercel quota or rate limit reached; ${retry} and run ${command}.`,
    );
  }
  if (isImageReadinessError(message)) {
    return new VercelProviderError(
      'image_not_ready',
      `The pinned Vercel image is not ready; wait for image readiness and retry ${command}.`,
    );
  }
  if (isAbortError(error, message)) {
    return new VercelProviderError('aborted', 'The Vercel operation was aborted; retry the command.');
  }
  if (isTimeoutError(error, message)) {
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
  return new VercelProviderError(
    'api',
    `Vercel API request failed${suffix}; check credentials and network access, then retry ${command}.`,
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
    case 'password': return `${base} --password`;
    case 'up': return base;
    default: return base;
  }
}

function removeRecoveryCommand(context: VercelErrorContext): string {
  if (context.action === 'list') return 'devbox --provider vercel --list';
  const branch = context.branch ?? '<branch>';
  return `devbox --provider vercel ${branch} --rm`;
}

function isConfirmationError(message: string): boolean {
  return [
    /\bvercel scope confirmation requires a tty\b/,
    /\bvercel scope confirmation was refused\b/,
    /\bconfirmation requires a tty\b/,
    /\bconfirmation was refused\b/,
  ].some((pattern) => pattern.test(message));
}

function isMetadataLockContention(error: unknown, message: string): boolean {
  return codeOf(error) === 'ELOCKED'
    || /^timed out waiting for vercel metadata lock: .+$/.test(message);
}

function isScopeLinkError(message: string): boolean {
  return message.includes('project link') || message.includes('project.json') || message.includes('linked project');
}

function isPartialCredentialError(message: string): boolean {
  return message.includes('missing vercel credential') || message.includes('explicit triad is incomplete');
}

function isPrivateRepoError(message: string): boolean {
  return message.includes('private')
    || message.includes('unable to resolve github credentials')
    || message.includes('clone')
    || message.includes('git authentication')
    || message.includes('repository access');
}

function isSourceError(message: string): boolean {
  return message.includes('github origin')
    || message.includes('github branch')
    || message.includes('github source')
    || message.includes('default branch')
    || message.includes('ls-remote')
    || message.includes('requested github branch')
    || message.includes('git source');
}

function isImageReadinessError(message: string): boolean {
  return message.includes('image_not_ready') || message.includes('image not ready') || message.includes('preparing') || message.includes('unoptimized');
}

function isAbortError(error: unknown, message: string): boolean {
  return (error instanceof Error && error.name === 'AbortError') || message.includes('aborted');
}

function isTimeoutError(error: unknown, message: string): boolean {
  return (error instanceof Error && error.name === 'TimeoutError') || message.includes('timed out') || message.includes('timeout');
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
