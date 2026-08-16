import {
  validateVercelImagePin,
  type VercelImagePin,
  type VercelImageReference,
} from './image.js';
import { normalizeRequestedSourceBranch } from './source.js';

export type VercelProviderSmokePath = 'existing' | 'missing' | 'both';

export interface VercelProviderSmokeBudget {
  pathCount: number;
  pathTimeoutMs: number;
  cleanupTimeoutMs: number;
  fixtureTimeoutMs: number;
  pathProbeTimeoutMs: number;
  outerTimeoutMs: number;
}

/**
 * Return the minimum wall-clock budget for sequential smoke execution. The
 * `both` path runs two complete path budgets, each followed by independent
 * cleanup, before the outer controller may expire.
 */
export function calculateVercelProviderSmokeBudget(
  path: VercelProviderSmokePath,
  pathTimeoutMs: number,
  cleanupTimeoutMs: number,
  fixtureTimeoutMs: number,
  pathProbeTimeoutMs: number,
): VercelProviderSmokeBudget {
  if (path !== 'existing' && path !== 'missing' && path !== 'both') {
    throw new TypeError('Vercel provider smoke path is invalid');
  }
  for (const [name, value] of [
    ['pathTimeoutMs', pathTimeoutMs],
    ['cleanupTimeoutMs', cleanupTimeoutMs],
    ['fixtureTimeoutMs', fixtureTimeoutMs],
    ['pathProbeTimeoutMs', pathProbeTimeoutMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be finite and positive`);
    }
  }
  const pathCount = path === 'both' ? 2 : 1;
  return {
    pathCount,
    pathTimeoutMs,
    cleanupTimeoutMs,
    fixtureTimeoutMs,
    pathProbeTimeoutMs,
    outerTimeoutMs: pathCount * (pathTimeoutMs + cleanupTimeoutMs + pathProbeTimeoutMs) + fixtureTimeoutMs,
  };
}

export const REQUIRED_VERCEL_PROVIDER_SMOKE_ENV = Object.freeze([
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  'GITHUB_FIXTURE_TOKEN',
  'GITHUB_FIXTURE_REPOSITORY',
  'GITHUB_FIXTURE_BRANCH',
  'GITHUB_FIXTURE_DEFAULT_BRANCH',
  'GITHUB_FIXTURE_EXPECTED_FILE',
  'GITHUB_FIXTURE_EXPECTED_CONTENT',
  'SMOKE_REPORT',
] as const);

export function assertPromotedVercelImagePin(pin: VercelImagePin): VercelImageReference {
  const validation = validateVercelImagePin(pin);
  if (!validation.ok || !validation.reference) {
    throw new Error(
      `Vercel provider smoke is blocked until the checked-in image pin is promoted and real-smoked: ${validation.errors.join('; ')}`,
    );
  }
  return validation.reference;
}

export interface VercelProviderSmokeConfig {
  credentials: {
    token: string;
    teamId: string;
    projectId: string;
  };
  fixture: {
    token: string;
    repository: string;
    branch: string;
    defaultBranch: string;
    expectedFile: string;
    expectedContent: string;
  };
  path: VercelProviderSmokePath;
  reportPath: string;
}

/**
 * Parse the credentialed provider-smoke contract without performing network or
 * Sandbox work. Secrets stay in the returned in-memory credentials object and
 * are never included in validation errors.
 */
export function parseVercelProviderSmokeConfig(
  env: Record<string, string | undefined>,
): VercelProviderSmokeConfig {
  const values = Object.fromEntries(
    REQUIRED_VERCEL_PROVIDER_SMOKE_ENV.map((name) => [name, env[name]]),
  ) as Record<typeof REQUIRED_VERCEL_PROVIDER_SMOKE_ENV[number], string | undefined>;
  const missing = REQUIRED_VERCEL_PROVIDER_SMOKE_ENV.filter((name) => name === 'GITHUB_FIXTURE_EXPECTED_CONTENT'
    ? !isNonEmptyString(values[name])
    : !isNonEmptySingleLine(values[name]));
  if (missing.length > 0) {
    throw new Error(`Vercel provider smoke configuration is incomplete; a complete Vercel/GitHub fixture triad is required, missing: ${missing.join(', ')}`);
  }

  const path = env.SMOKE_PATH ?? 'both';
  if (path !== 'existing' && path !== 'missing' && path !== 'both') {
    throw new Error('SMOKE_PATH must be existing, missing, or both');
  }

  const repository = values.GITHUB_FIXTURE_REPOSITORY!.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(repository)) {
    throw new Error('GITHUB_FIXTURE_REPOSITORY must be an exact owner/repository pair');
  }

  const branch = normalizeSmokeBranch(values.GITHUB_FIXTURE_BRANCH!, 'GITHUB_FIXTURE_BRANCH');
  const defaultBranch = normalizeSmokeBranch(values.GITHUB_FIXTURE_DEFAULT_BRANCH!, 'GITHUB_FIXTURE_DEFAULT_BRANCH');
  const expectedFile = validateExpectedFile(values.GITHUB_FIXTURE_EXPECTED_FILE!);
  const expectedContent = values.GITHUB_FIXTURE_EXPECTED_CONTENT!;

  return {
    credentials: {
      token: values.VERCEL_TOKEN!.trim(),
      teamId: requireScopeValue(values.VERCEL_TEAM_ID!, 'VERCEL_TEAM_ID'),
      projectId: requireScopeValue(values.VERCEL_PROJECT_ID!, 'VERCEL_PROJECT_ID'),
    },
    fixture: {
      token: values.GITHUB_FIXTURE_TOKEN!.trim(),
      repository,
      branch,
      defaultBranch,
      expectedFile,
      expectedContent,
    },
    path,
    reportPath: values.SMOKE_REPORT!.trim(),
  };
}

function normalizeSmokeBranch(value: string, name: string): string {
  try {
    return normalizeRequestedSourceBranch(value);
  } catch (error) {
    throw new Error(`${name} is not a valid Git branch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateExpectedFile(value: string): string {
  const file = value.trim();
  if (!file || file.startsWith('/') || file.includes('\\') || file.includes('\0')) {
    throw new Error('GITHUB_FIXTURE_EXPECTED_FILE must be a non-empty relative POSIX path');
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('GITHUB_FIXTURE_EXPECTED_FILE must not contain empty, dot, or parent path segments');
  }
  return file;
}

function requireScopeValue(value: string, name: string): string {
  if (/\s/.test(value)) throw new Error(`${name} must not contain whitespace`);
  return value.trim();
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptySingleLine(value: string | undefined): value is string {
  return isNonEmptyString(value) && !value.includes('\n') && !value.includes('\r');
}
