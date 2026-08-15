import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export interface DeviceAuthPrimitives {
  OAuth: typeof sdkOAuth;
  pollForToken: typeof sdkPollForToken;
  getAuth: typeof sdkGetAuth;
}

export interface CredentialResolutionOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  deviceAuth?: (scope: VercelScope) => Promise<VercelCredentials>;
  deviceAuthPrimitives?: Partial<DeviceAuthPrimitives>;
  onDeviceAuthorization?: (request: DeviceAuthorizationRequest) => void | Promise<void>;
}

/** Resolve the explicit Vercel credential source. */
export async function resolveVercelCredentials(
  options: CredentialResolutionOptions,
): Promise<VercelCredentials> {
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
    const linkedScope = await readLinkedScope(options.repoRoot, false);
    if (
      linkedScope &&
      (linkedScope.teamId !== payload.owner_id || linkedScope.projectId !== payload.project_id)
    ) {
      throw new Error('Vercel scope conflict between OIDC token and linked project');
    }
    return { token: oidcToken, teamId: payload.owner_id, projectId: payload.project_id };
  }

  const linkedScope = await readLinkedScope(options.repoRoot, true);
  if (!linkedScope) {
    throw new Error('Vercel project link is missing');
  }
  if (options.deviceAuth) {
    return options.deviceAuth(linkedScope);
  }

  return authenticateWithDeviceAuth(linkedScope, options);
}

async function authenticateWithDeviceAuth(
  scope: LinkedScope,
  options: CredentialResolutionOptions,
): Promise<VercelCredentials> {
  const primitives: DeviceAuthPrimitives = {
    OAuth: options.deviceAuthPrimitives?.OAuth ?? sdkOAuth,
    pollForToken: options.deviceAuthPrimitives?.pollForToken ?? sdkPollForToken,
    getAuth: options.deviceAuthPrimitives?.getAuth ?? sdkGetAuth,
  };
  const oauth = await primitives.OAuth();
  const request = await oauth.deviceAuthorizationRequest();
  await options.onDeviceAuthorization?.(request);

  for await (const result of primitives.pollForToken({ request, oauth })) {
    if (result._tag === 'Error') {
      throw result.error;
    }
  }

  const auth = primitives.getAuth();
  if (!auth?.token) {
    throw new Error('Vercel device authentication completed without a token');
  }
  return { token: auth.token, teamId: scope.teamId, projectId: scope.projectId };
}

interface LinkedScope {
  teamId: string;
  projectId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readLinkedScope(repoRoot: string, required: boolean): Promise<LinkedScope | null> {
  const pathname = join(repoRoot, '.vercel', 'project.json');

  let content: string;
  try {
    content = await readFile(pathname, 'utf8');
  } catch (error) {
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
    return { teamId: parsed.orgId, projectId: parsed.projectId };
  } catch (error) {
    throw new Error(
      `Malformed Vercel project link: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
