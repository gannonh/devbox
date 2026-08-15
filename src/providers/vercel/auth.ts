import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import {
  getAuth as sdkGetAuth,
  OAuth as sdkOAuth,
  pollForToken as sdkPollForToken,
} from '@vercel/sandbox/dist/auth/index.js';
import type { DeviceAuthorizationRequest } from '@vercel/sandbox/dist/auth/index.js';

export interface VercelScope {
  teamId: string;
  projectId: string;
}

export interface ScopeConfirmationBoundary {
  render(scope: VercelScope): string;
  confirm(message: string, scope: VercelScope): boolean | Promise<boolean>;
}

export function renderVercelScope(scope: VercelScope): string {
  return `Vercel team: ${scope.teamId}\nVercel project: ${scope.projectId}`;
}

export async function confirmVercelScope(
  scope: VercelScope,
  boundary: ScopeConfirmationBoundary,
): Promise<void> {
  const message = boundary.render(scope);
  if (!(await boundary.confirm(message, scope))) {
    throw new Error('Vercel scope confirmation was refused');
  }
}

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

export type DeviceAuthResult = string | VercelCredentials;

export interface DeviceAuthContext {
  signal: AbortSignal;
  deadline?: number;
}

export interface DeviceAuthPrimitives {
  OAuth: typeof sdkOAuth;
  pollForToken: typeof sdkPollForToken;
  getAuth: typeof sdkGetAuth;
}

export interface CredentialResolutionOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  deviceAuth?: (scope: VercelScope, context: DeviceAuthContext) => Promise<DeviceAuthResult>;
  deviceAuthPrimitives?: Partial<DeviceAuthPrimitives>;
  onDeviceAuthorization?: (request: DeviceAuthorizationRequest) => void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Absolute epoch-millisecond deadline for authentication. */
  deadline?: number;
}

/** Resolve Vercel credentials without relying on SDK lazy authentication. */
export async function resolveVercelCredentials(
  options: CredentialResolutionOptions,
): Promise<VercelCredentials> {
  const cancellation = createCancellation(options);
  try {
    throwIfAborted(cancellation.signal);
    const env = options.env ?? process.env;
    const token = env.VERCEL_TOKEN;
    const teamId = env.VERCEL_TEAM_ID;
    const projectId = env.VERCEL_PROJECT_ID;

    const explicitValues = { token, teamId, projectId };
    const hasExplicitValue = Object.values(explicitValues).some((value) => value !== undefined);

    if (isNonEmptyString(token) && isNonEmptyString(teamId) && isNonEmptyString(projectId)) {
      return { token, teamId, projectId };
    }

    if (hasExplicitValue) {
      const missing = Object.entries(explicitValues)
        .filter(([, value]) => !isNonEmptyString(value))
        .map(([name]) => name)
        .join(', ');
      throw new Error(`Missing Vercel credential(s): ${missing}; explicit triad is incomplete`);
    }

    const oidcToken = env.VERCEL_OIDC_TOKEN;
    if (isNonEmptyString(oidcToken)) {
      const payloadSegment = oidcToken.split('.')[1];
      if (!payloadSegment) {
        throw new Error('Invalid Vercel OIDC token: JWT payload is missing');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
      } catch (error) {
        throw new Error(
          `Invalid Vercel OIDC token: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        !isRecord(payload) ||
        !isNonEmptyString(payload.owner_id) ||
        !isNonEmptyString(payload.project_id)
      ) {
        throw new Error('Invalid Vercel OIDC token: OIDC payload must contain string owner_id and project_id');
      }
      const oidcScope = {
        teamId: payload.owner_id.trim(),
        projectId: payload.project_id.trim(),
      };
      const linkedScope = await readLinkedScope(options.repoRoot, false, cancellation.signal);
      if (
        linkedScope &&
        (linkedScope.teamId !== oidcScope.teamId || linkedScope.projectId !== oidcScope.projectId)
      ) {
        throw new Error('Vercel scope conflict between OIDC token and linked project');
      }
      return { token: oidcToken, ...oidcScope };
    }

    const linkedScope = await readLinkedScope(options.repoRoot, true, cancellation.signal);
    if (options.deviceAuth) {
      const result = await callWithCancellation(
        () => options.deviceAuth!(linkedScope, {
          signal: cancellation.signal,
          deadline: cancellation.deadline,
        }),
        cancellation.signal,
      );
      return normalizeInjectedDeviceAuth(result, linkedScope);
    }

    return await authenticateWithDeviceAuth(linkedScope, options, cancellation);
  } finally {
    cancellation.dispose();
  }
}

async function authenticateWithDeviceAuth(
  scope: LinkedScope,
  options: CredentialResolutionOptions,
  cancellation: Cancellation,
): Promise<VercelCredentials> {
  if (!options.onDeviceAuthorization) {
    throw new Error('onDeviceAuthorization callback is required for device authentication');
  }
  const primitives: DeviceAuthPrimitives = {
    OAuth: options.deviceAuthPrimitives?.OAuth ?? sdkOAuth,
    pollForToken: options.deviceAuthPrimitives?.pollForToken ?? sdkPollForToken,
    getAuth: options.deviceAuthPrimitives?.getAuth ?? sdkGetAuth,
  };
  const oauth = await callWithCancellation(
    () => primitives.OAuth(),
    cancellation.signal,
  );
  const request = await callWithCancellation(
    () => oauth.deviceAuthorizationRequest(),
    cancellation.signal,
  );
  await callWithCancellation(
    () => options.onDeviceAuthorization!(request),
    cancellation.signal,
  );

  await consumeTokenPoll(
    primitives.pollForToken({ request, oauth }),
    cancellation.signal,
  );

  throwIfAborted(cancellation.signal);
  const auth = await callWithCancellation(() => primitives.getAuth(), cancellation.signal);
  if (!auth?.token || auth.token.trim().length === 0) {
    throw new Error('Vercel device authentication completed without a token');
  }
  return { token: auth.token, teamId: scope.teamId, projectId: scope.projectId };
}

async function consumeTokenPoll(
  generator: AsyncGenerator<Awaited<ReturnType<typeof sdkPollForToken>> extends AsyncGenerator<infer Item> ? Item : never>,
  signal: AbortSignal,
): Promise<void> {
  const iterator = generator[Symbol.asyncIterator]();
  let failure: unknown;
  try {
    while (true) {
      const step = await callWithCancellation(() => iterator.next(), signal);
      if (step.done) break;
      if (step.value._tag === 'Error') {
        failure = step.value.error;
        break;
      }
    }
  } catch (error) {
    failure = error;
  }

  let cleanupError: unknown;
  if (iterator.return) {
    try {
      const returnPromise = iterator.return(undefined);
      await awaitWithCancellation(Promise.resolve(returnPromise), signal);
    } catch (error) {
      if (!signal.aborted) cleanupError = error;
    }
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
}

function normalizeInjectedDeviceAuth(
  result: DeviceAuthResult,
  scope: LinkedScope,
): VercelCredentials {
  if (typeof result === 'string') {
    return { token: requireAuthToken(result), teamId: scope.teamId, projectId: scope.projectId };
  }
  if (!isRecord(result)) {
    throw new Error('Injected device authentication returned an invalid result');
  }
  const token = requireAuthToken(result.token);
  if (result.teamId !== scope.teamId || result.projectId !== scope.projectId) {
    throw new Error('Injected device authentication scope mismatch');
  }
  return { token, teamId: scope.teamId, projectId: scope.projectId };
}

function requireAuthToken(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error('Injected device authentication returned a non-empty token');
  }
  return value.trim();
}

interface LinkedScope {
  teamId: string;
  projectId: string;
}

interface Cancellation {
  signal: AbortSignal;
  deadline?: number;
  dispose(): void;
}

function createCancellation(options: CredentialResolutionOptions): Cancellation {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    throw new Error('Authentication timeoutMs must be non-negative');
  }
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
    throw new Error('Authentication deadline must be finite');
  }

  const controller = new AbortController();
  const externalSignal = options.signal;
  const now = Date.now();
  const timeoutDeadline = options.timeoutMs === undefined ? Infinity : now + options.timeoutMs;
  const deadline = Math.min(timeoutDeadline, options.deadline ?? Infinity);
  let timer: NodeJS.Timeout | undefined;
  let externalAbort: (() => void) | undefined;

  const abortForReason = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) abortForReason(externalSignal.reason);
    else {
      externalAbort = () => abortForReason(externalSignal.reason);
      externalSignal.addEventListener('abort', externalAbort, { once: true });
    }
  }
  if (!controller.signal.aborted && Number.isFinite(deadline)) {
    const delay = deadline - now;
    if (delay <= 0) abortForReason(new Error('Vercel authentication timed out'));
    else {
      timer = setTimeout(() => abortForReason(new Error('Vercel authentication timed out')), delay);
      timer.unref();
    }
  }

  return {
    signal: controller.signal,
    deadline: Number.isFinite(deadline) ? deadline : undefined,
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (externalSignal && externalAbort) externalSignal.removeEventListener('abort', externalAbort);
    },
  };
}

async function callWithCancellation<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  return awaitWithCancellation(Promise.resolve().then(operation), signal);
}

async function awaitWithCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancellationError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal);
}

function cancellationError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Vercel authentication aborted');
  error.name = 'AbortError';
  return error;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLinkedScope(repoRoot: string, required: true, signal: AbortSignal): Promise<LinkedScope>;
function readLinkedScope(repoRoot: string, required: false, signal: AbortSignal): Promise<LinkedScope | null>;
async function readLinkedScope(repoRoot: string, required: boolean, signal: AbortSignal): Promise<LinkedScope | null> {
  const pathname = join(repoRoot, '.vercel', 'project.json');

  let content: string;
  try {
    content = await readFile(pathname, { encoding: 'utf8', signal });
  } catch (error) {
    if (signal.aborted) throw cancellationError(signal);
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      if (required) {
        throw new Error(`Vercel project link is missing: ${pathname}`);
      }
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(content) as { orgId?: unknown; projectId?: unknown };
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !isNonEmptyString(parsed.orgId) ||
      !isNonEmptyString(parsed.projectId)
    ) {
      throw new Error('project.json must contain non-empty string orgId and projectId');
    }
    return { teamId: parsed.orgId.trim(), projectId: parsed.projectId.trim() };
  } catch (error) {
    throw new Error(
      `Malformed Vercel project link: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
