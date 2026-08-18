import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
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
  scope?: VercelScope;
  deviceAuth?: (scope: VercelScope, context: DeviceAuthContext) => Promise<DeviceAuthResult>;
  deviceAuthPrimitives?: Partial<DeviceAuthPrimitives>;
  onDeviceAuthorization?: (request: DeviceAuthorizationRequest) => void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Absolute epoch-millisecond deadline for authentication. */
  deadline?: number;
}

export interface StoredScopeCredentialResolutionOptions extends CredentialResolutionOptions {
  scope: VercelScope;
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
      return { token: requireVercelToken(token), teamId, projectId };
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
      const oidcScope = parseVercelOidcScope(oidcToken);
      const linkedScope = await readLinkedScope(options.repoRoot, false, cancellation.signal);
      if (
        linkedScope &&
        (linkedScope.teamId !== oidcScope.teamId || linkedScope.projectId !== oidcScope.projectId)
      ) {
        throw new Error('Vercel scope conflict between OIDC token and linked project');
      }
      if (options.scope) assertCredentialScope(options.scope, oidcScope);
      return { token: oidcToken, ...oidcScope };
    }

    const linkedScope = options.scope ?? await readLinkedScope(options.repoRoot, true, cancellation.signal);
    const cachedCredentials = readCachedCredentials(options, linkedScope);
    if (cachedCredentials) return cachedCredentials;

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

/** Resolve credentials for an existing record without requiring GitHub credentials. */
export async function resolveVercelCredentialsForScope(
  options: StoredScopeCredentialResolutionOptions,
): Promise<VercelCredentials> {
  const env = options.env ?? process.env;
  const token = env.VERCEL_TOKEN;
  const teamId = env.VERCEL_TEAM_ID;
  const projectId = env.VERCEL_PROJECT_ID;
  const oidcToken = env.VERCEL_OIDC_TOKEN;
  const hasExplicitTriadValue = [token, teamId, projectId].some((value) => value !== undefined);

  if (isNonEmptyString(token) && teamId === undefined && projectId === undefined && oidcToken === undefined) {
    return { token: requireVercelToken(token), ...options.scope };
  }

  if (isNonEmptyString(oidcToken) && !hasExplicitTriadValue) {
    const oidcScope = parseVercelOidcScope(oidcToken);
    assertCredentialScope(options.scope, oidcScope);
    return { token: requireVercelToken(oidcToken), ...options.scope };
  }

  const credentials = await resolveVercelCredentials({ ...options, scope: options.scope });
  assertCredentialScope(options.scope, credentials);
  return { ...credentials, ...options.scope };
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

function readCachedCredentials(
  options: CredentialResolutionOptions,
  scope: LinkedScope,
): VercelCredentials | undefined {
  // Injected auth seams own credential resolution; only the production path
  // reads the SDK's persisted auth file.
  if (options.deviceAuth !== undefined || options.deviceAuthPrimitives !== undefined) return undefined;
  const auth = sdkGetAuth();
  if (!auth?.token || (auth.expiresAt && auth.expiresAt.getTime() <= Date.now())) return undefined;
  return { token: requireVercelToken(auth.token), ...scope };
}

function requireAuthToken(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error('Injected device authentication returned an empty token');
  }
  return value.trim();
}

function requireVercelToken(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('Vercel token environment value must be single-line');
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

function isBase64UrlSegment(value: string): boolean {
  return value.length > 0 && value.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(value);
}

function parseVercelOidcScope(oidcToken: string): VercelScope {
  const segments = oidcToken.split('.');
  if (segments.length !== 3 || segments.some((segment) => !isBase64UrlSegment(segment))) {
    throw new Error('Invalid Vercel OIDC token: JWT segments contain invalid characters');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
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
  return {
    teamId: payload.owner_id.trim(),
    projectId: payload.project_id.trim(),
  };
}

function assertCredentialScope(expected: VercelScope, actual: VercelScope): void {
  if (expected.teamId !== actual.teamId || expected.projectId !== actual.projectId) {
    throw new Error('Stored Vercel team/project does not match resolved credentials');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLinkedScope(repoRoot: string, required: true, signal: AbortSignal): Promise<LinkedScope>;
function readLinkedScope(repoRoot: string, required: false, signal: AbortSignal): Promise<LinkedScope | null>;
async function readLinkedScope(repoRoot: string, required: boolean, signal: AbortSignal): Promise<LinkedScope | null> {
  const pathname = join(repoRoot, '.vercel', 'project.json');

  let content: string;
  let handle: FileHandle | undefined;
  try {
    handle = await open(pathname, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Vercel project link must be a regular file: ${pathname}`);
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(`Vercel project link must not be group/world writable: ${pathname}`);
    }
    content = await handle.readFile({ encoding: 'utf8', signal });
  } catch (error) {
    if (signal.aborted) throw cancellationError(signal);
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      if (required) {
        throw new Error(`Vercel project link is missing: ${pathname}`);
      }
      return null;
    }
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') {
      throw new Error(`Vercel project link must not be a symbolic link: ${pathname}`);
    }
    throw error;
  } finally {
    if (handle) await handle.close();
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
