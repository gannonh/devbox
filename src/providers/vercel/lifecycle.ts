import type { CredentialResolutionOptions, VercelCredentials } from './auth.js';
import { resolveVercelCredentials } from './auth.js';
import {
  cleanupVercelSandbox,
  type VercelCleanupAdapter,
  type VercelCleanupOptions,
  type VercelCleanupResult,
} from './cleanup.js';
import {
  buildVercelSandboxCreateRequest,
  isVercelNotFound,
  type SandboxSessionRecord,
  type VercelCommandResult,
  type VercelSandboxClient,
  type VercelSandboxHandle,
  type VercelStopResult,
} from './client.js';
import { VERCEL_IMAGE_PIN } from './image.js';
import { createVercelIdentity, type VercelSandboxIdentity } from './identity.js';
import {
  createVercelMetadataStore,
  type VercelCreateConfiguration,
  type VercelMetadata,
  type VercelMetadataIdentity,
  type VercelMetadataStore,
} from './metadata.js';
import { renderRemoteSourceNotice, resolveGitHubSource, type GitHubSourcePlan } from './source.js';
import { redactSecrets } from './redaction.js';

export const DEFAULT_VERCEL_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_STATES = new Set(['stopped', 'aborted']);

export class VercelLifecycleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'VercelLifecycleError';
    this.code = code;
  }
}

export class VercelResourceNotFoundError extends VercelLifecycleError {
  readonly resource: string;

  constructor(resource: string, name: string) {
    super('resource_not_found', `Vercel ${resource} was not found: ${name}`);
    this.name = 'VercelResourceNotFoundError';
    this.resource = resource;
  }
}

export class VercelIdentityConflictError extends VercelLifecycleError {
  constructor(message: string) {
    super('identity_conflict', message);
    this.name = 'VercelIdentityConflictError';
  }
}

export class VercelScopeConflictError extends VercelLifecycleError {
  constructor(message: string) {
    super('scope_conflict', message);
    this.name = 'VercelScopeConflictError';
  }
}

export class VercelRouteNotFoundError extends VercelLifecycleError {
  constructor(name: string, port: number) {
    super('route_not_found', `Vercel Sandbox ${name} has no route for port ${port}`);
    this.name = 'VercelRouteNotFoundError';
  }
}

export class VercelCleanupError extends VercelLifecycleError {
  readonly result: VercelCleanupResult;

  constructor(result: VercelCleanupResult) {
    super(
      'cleanup_incomplete',
      `Vercel Sandbox cleanup is incomplete; retry is required${
        result.errors.length > 0 ? `: ${result.errors.join('; ')}` : ''
      }`,
    );
    this.name = 'VercelCleanupError';
    this.result = result;
  }
}

export interface VercelLifecycleOptions {
  repoRoot: string;
  branch: string;
  packageVersion?: string;
  env?: Record<string, string | undefined>;
  credentials?: VercelCredentials;
  credentialOptions?: Omit<CredentialResolutionOptions, 'repoRoot' | 'env'>;
  source?: GitHubSourcePlan;
  sourceResolver?: () => Promise<GitHubSourcePlan>;
  metadataStore?: VercelMetadataStore;
  stateHome?: string;
  repoKey?: string;
  client?: VercelSandboxClient;
  imageReference?: string;
  timeoutMs?: number;
  onNotice?: (notice: string) => void | Promise<void>;
  cleanup?: Pick<VercelCleanupOptions, 'timeoutMs' | 'maxAttempts' | 'backoffMs' | 'sleep'>;
}

export interface VercelStopReport {
  name: string;
  sessions: SandboxSessionRecord[];
  finalSession?: SandboxSessionRecord;
  snapshot?: {
    id: string;
    status: string;
  };
  activeCpuUsageMs?: number;
  networkTransfer?: { ingress: number; egress: number };
}

export interface VercelLifecycle {
  up(): Promise<VercelSandboxHandle>;
  get(options?: { resume?: boolean }): Promise<VercelSandboxHandle>;
  attach(): Promise<VercelSandboxHandle>;
  list(): Promise<ReadonlyArray<{
    name: string;
    tags?: Record<string, string>;
    status: string;
    image?: string;
    [key: string]: unknown;
  }>>;
  routes(): Promise<readonly { url: string; subdomain: string; port: number }[]>;
  url(port: number): Promise<string>;
  stop(): Promise<VercelStopReport>;
  remove(): Promise<VercelCleanupResult>;
}

interface PreparedContext {
  credentials: VercelCredentials;
  source: GitHubSourcePlan;
  identity: VercelSandboxIdentity;
  metadataStore: VercelMetadataStore;
  client: VercelSandboxClient;
  imageReference: string;
  timeoutMs: number;
  configuration: VercelCreateConfiguration;
}

export function createVercelLifecycle(options: VercelLifecycleOptions): VercelLifecycle {
  let contextPromise: Promise<PreparedContext> | undefined;
  const getContext = (): Promise<PreparedContext> => {
    contextPromise ??= prepareContext(options);
    return contextPromise;
  };

  return {
    up: async () => {
      const context = await getContext();
      await options.onNotice?.(context.source.warning || renderRemoteSourceNotice());
      return context.metadataStore.withLock(async () => {
        const existing = await context.metadataStore.read();
        assertScopeAndIdentity(existing, context);
        if (existing?.configuration) assertConfiguration(existing.configuration, context.configuration);

        const createRequest = buildVercelSandboxCreateRequest({
          credentials: context.credentials,
          name: context.identity.name,
          imageReference: context.imageReference,
          source: context.source.source,
          timeoutMs: context.timeoutMs,
          tags: { ...context.identity.tags },
          onCreate: context.source.needsBranchSetup
            ? (sandbox) => switchToRequestedBranch(sandbox, context)
            : undefined,
        });
        const sandbox = await context.client.getOrCreate({
          credentials: context.credentials,
          ...createRequest,
        });
        validateSandboxIdentity(sandbox, context);
        await context.metadataStore.write({
          teamId: context.credentials.teamId,
          projectId: context.credentials.projectId,
          identity: toMetadataIdentity(context.identity),
          sandboxId: sandboxIdentifier(sandbox),
          configuration: context.configuration,
        });
        return sandbox;
      });
    },
    get: async (request = {}) => {
      const context = await getContext();
      return context.metadataStore.withLock(async () => {
        const metadata = await context.metadataStore.read();
        const identity = requireStoredIdentity(metadata, context);
        const credentials = credentialsForStoredScope(context.credentials, metadata);
        const sandbox = await getExistingSandbox(context, credentials, identity.name, request.resume ?? true);
        validateSandboxIdentity(sandbox, context, identity);
        return sandbox;
      });
    },
    attach: async () => {
      const context = await getContext();
      return context.metadataStore.withLock(async () => {
        const metadata = await context.metadataStore.read();
        const identity = requireStoredIdentity(metadata, context);
        const credentials = credentialsForStoredScope(context.credentials, metadata);
        const sandbox = await getExistingSandbox(context, credentials, identity.name, true);
        validateSandboxIdentity(sandbox, context, identity);
        return sandbox;
      });
    },
    list: async () => {
      const context = await getContext();
      return context.metadataStore.withLock(async () => {
        const metadata = await context.metadataStore.read();
        if (metadata) assertScopeAndIdentity(metadata, context);
        const identity = metadata?.identity ?? toMetadataIdentity(context.identity);
        const credentials = metadata
          ? credentialsForStoredScope(context.credentials, metadata)
          : context.credentials;
        const records = await context.client.listSandboxes({
          credentials,
          tags: {
            provider: identity.tags.provider,
            repository: identity.tags.repository,
          },
        });
        return records.filter((record) => (
          record.tags?.provider === identity.tags.provider &&
          record.tags?.repository === identity.tags.repository
        ));
      });
    },
    routes: async () => {
      const sandbox = await getExistingForOperation(getContext);
      return sandbox.routes ?? [];
    },
    url: async (port) => {
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new VercelRouteNotFoundError('unknown', port);
      }
      const sandbox = await getExistingForOperation(getContext);
      if (!(sandbox.routes ?? []).some((route) => route.port === port)) {
        throw new VercelRouteNotFoundError(sandbox.name, port);
      }
      return sandbox.domain(port);
    },
    stop: async () => {
      const context = await getContext();
      return context.metadataStore.withLock(async () => {
        const metadata = await context.metadataStore.read();
        const identity = requireStoredIdentity(metadata, context);
        const credentials = credentialsForStoredScope(context.credentials, metadata);
        const sandbox = await getExistingSandbox(context, credentials, identity.name, false);
        validateSandboxIdentity(sandbox, context, identity);
        let sessions = await context.client.listSessions(sandbox);
        let finalStop: VercelStopResult | undefined;
        if (!allTerminal(sessions) || isStoppableStatus(sandbox.status)) {
          finalStop = await context.client.stopSandbox(sandbox);
          sessions = await context.client.listSessions(sandbox);
        }
        if (!allTerminal(sessions)) {
          throw new VercelLifecycleError('stop_incomplete', 'Vercel Sandbox still has a non-terminal session');
        }
        const snapshot = finalStop?.snapshot;
        await context.metadataStore.write({
          teamId: credentials.teamId,
          projectId: credentials.projectId,
          identity,
          sandboxId: sandboxIdentifier(sandbox),
          ...(snapshot === undefined ? {} : { snapshotIds: [snapshot.id] }),
          configuration: context.configuration,
        });
        const finalSession = sessions.at(-1);
        const activeCpuUsageMs = finalStop?.activeCpuDurationMs
          ?? finalSession?.activeCpuDurationMs
          ?? sandbox.activeCpuUsageMs;
        const networkTransfer = finalStop?.networkTransfer
          ?? finalSession?.networkTransfer
          ?? sandbox.networkTransfer;
        return {
          name: sandbox.name,
          sessions,
          ...(finalSession === undefined ? {} : { finalSession }),
          ...(snapshot === undefined ? {} : { snapshot: { id: snapshot.id, status: snapshot.status } }),
          ...(activeCpuUsageMs === undefined ? {} : { activeCpuUsageMs }),
          ...(networkTransfer === undefined ? {} : { networkTransfer }),
        };
      });
    },
    remove: async () => {
      const context = await getContext();
      return context.metadataStore.withLock(async () => {
        const metadata = await context.metadataStore.read();
        if (metadata) assertScopeAndIdentity(metadata, context);
        const identity = metadata?.identity ?? toMetadataIdentity(context.identity);
        const credentials = metadata
          ? credentialsForStoredScope(context.credentials, metadata)
          : context.credentials;
        const adapter = createCleanupAdapter(context.client);
        const result = await cleanupVercelSandbox({
          name: identity.name,
          credentials,
          adapter,
          ...(options.cleanup ?? {}),
        });
        if (result.verified) {
          await context.metadataStore.remove();
          return result;
        }
        await context.metadataStore.write({
          teamId: credentials.teamId,
          projectId: credentials.projectId,
          identity,
          sandboxId: metadata?.sandboxId ?? identity.name,
          ...(metadata?.snapshotIds === undefined ? {} : { snapshotIds: metadata.snapshotIds }),
          configuration: metadata?.configuration ?? context.configuration,
          residual: {
            sandboxIds: result.residualSandboxIds,
            snapshotIds: result.residualSnapshotIds,
            reason: result.errors.join('; ') || 'Vercel cleanup verification did not converge',
          },
        });
        throw new VercelCleanupError(result);
      });
    },
  };
}

async function prepareContext(options: VercelLifecycleOptions): Promise<PreparedContext> {
  const source = options.source
    ?? (options.sourceResolver ? await options.sourceResolver() : await resolveGitHubSource({
      repoRoot: options.repoRoot,
      branch: options.branch,
      env: options.env,
    }));
  const packageVersion = options.packageVersion ?? undefined;
  const identity = createVercelIdentity({
    remote: source.remote.canonical,
    branch: source.requestedBranch,
    ...(packageVersion === undefined ? {} : { packageVersion }),
  });
  const credentials = options.credentials
    ?? await resolveVercelCredentials({
      repoRoot: options.repoRoot,
      env: options.env,
      ...options.credentialOptions,
    });
  const imageReference = options.imageReference ?? VERCEL_IMAGE_PIN.reference;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERCEL_SANDBOX_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Vercel Sandbox timeout must be positive');
  }
  const metadataStore = options.metadataStore ?? createVercelMetadataStore({
    repoKey: options.repoKey ?? source.remote.canonical,
    stateHome: options.stateHome,
  });
  const client = options.client;
  if (!client) throw new Error('Vercel Sandbox client is required');
  return {
    credentials,
    source,
    identity,
    metadataStore,
    client,
    imageReference,
    timeoutMs,
    configuration: {
      imageReference,
      sourceUrl: source.source.url,
      sourceRevision: source.source.revision,
      requestedBranch: source.requestedBranch,
      needsBranchSetup: source.needsBranchSetup,
      persistent: true,
      keepLastSnapshots: 1,
      timeoutMs,
    },
  };
}

async function getExistingForOperation(
  getContext: () => Promise<PreparedContext>,
): Promise<VercelSandboxHandle> {
  const context = await getContext();
  return context.metadataStore.withLock(async () => {
    const metadata = await context.metadataStore.read();
    const identity = requireStoredIdentity(metadata, context);
    const credentials = credentialsForStoredScope(context.credentials, metadata);
    const sandbox = await getExistingSandbox(context, credentials, identity.name, true);
    validateSandboxIdentity(sandbox, context, identity);
    return sandbox;
  });
}

async function getExistingSandbox(
  context: PreparedContext,
  credentials: VercelCredentials,
  name: string,
  resume: boolean,
): Promise<VercelSandboxHandle> {
  try {
    return await context.client.get({ credentials, name, resume });
  } catch (error) {
    if (isVercelNotFound(error)) throw new VercelResourceNotFoundError('Sandbox', name);
    throw error;
  }
}

function requireStoredIdentity(
  metadata: VercelMetadata | null,
  context: PreparedContext,
): VercelMetadataIdentity {
  if (!metadata) throw new VercelResourceNotFoundError('metadata record', context.identity.canonicalRepository);
  assertScopeAndIdentity(metadata, context);
  if (!metadata.identity) {
    throw new VercelLifecycleError('metadata_incomplete', 'Vercel metadata does not contain sandbox identity');
  }
  return metadata.identity;
}

function credentialsForStoredScope(
  credentials: VercelCredentials,
  metadata: VercelMetadata | null,
): VercelCredentials {
  if (!metadata) return credentials;
  if (metadata.teamId !== credentials.teamId || metadata.projectId !== credentials.projectId) {
    throw new VercelScopeConflictError('Stored Vercel team/project does not match resolved credentials');
  }
  return {
    token: credentials.token,
    teamId: metadata.teamId,
    projectId: metadata.projectId,
  };
}

function assertScopeAndIdentity(metadata: VercelMetadata | null, context: PreparedContext): void {
  if (!metadata) return;
  if (metadata.teamId !== context.credentials.teamId || metadata.projectId !== context.credentials.projectId) {
    throw new VercelScopeConflictError('Stored Vercel team/project does not match resolved credentials');
  }
  if (metadata.identity && !sameMetadataIdentity(metadata.identity, context.identity)) {
    throw new VercelIdentityConflictError('Stored Vercel Sandbox identity does not match this repository and branch');
  }
}

function assertConfiguration(
  actual: VercelCreateConfiguration,
  expected: VercelCreateConfiguration,
): void {
  if (
    actual.imageReference !== expected.imageReference ||
    actual.sourceUrl !== expected.sourceUrl ||
    actual.sourceRevision !== expected.sourceRevision ||
    actual.requestedBranch !== expected.requestedBranch ||
    actual.needsBranchSetup !== expected.needsBranchSetup ||
    actual.persistent !== expected.persistent ||
    actual.keepLastSnapshots !== expected.keepLastSnapshots ||
    actual.timeoutMs !== expected.timeoutMs
  ) {
    throw new VercelIdentityConflictError('Stored Vercel Sandbox create-only configuration conflicts with this request');
  }
}

function validateSandboxIdentity(
  sandbox: VercelSandboxHandle,
  context: PreparedContext,
  storedIdentity?: VercelMetadataIdentity,
): void {
  const expectedName = storedIdentity?.name ?? context.identity.name;
  const expectedTags = storedIdentity?.tags ?? context.identity.tags;
  if (sandbox.name !== expectedName) {
    throw new VercelIdentityConflictError(`Vercel Sandbox name conflict for ${expectedName}`);
  }
  if (!sandbox.tags || !sameTags(sandbox.tags, expectedTags)) {
    throw new VercelIdentityConflictError(`Vercel Sandbox tags conflict for ${expectedName}`);
  }
  if (sandbox.image !== undefined && sandbox.image !== context.imageReference) {
    throw new VercelIdentityConflictError(`Vercel Sandbox image conflicts for ${expectedName}`);
  }
  if (sandbox.timeout !== undefined && sandbox.timeout !== context.timeoutMs) {
    throw new VercelIdentityConflictError(`Vercel Sandbox timeout conflicts for ${expectedName}`);
  }
  if (sandbox.persistent === false) {
    throw new VercelIdentityConflictError(`Vercel Sandbox persistence conflicts for ${expectedName}`);
  }
  if (sandbox.keepLastSnapshots && sandbox.keepLastSnapshots.count !== 1) {
    throw new VercelIdentityConflictError(`Vercel Sandbox snapshot retention conflicts for ${expectedName}`);
  }
}

async function switchToRequestedBranch(
  sandbox: VercelSandboxHandle,
  context: PreparedContext,
): Promise<void> {
  const result = await context.client.runCommand(
    sandbox,
    'git',
    ['switch', '--create', context.source.requestedBranch, '--'],
  );
  if (result.exitCode === 0) return;
  const output = await commandOutput(result);
  throw new VercelLifecycleError(
    'branch_setup_failed',
    `Unable to create requested Git branch ${context.source.requestedBranch}${output ? `: ${redactSecrets(output, [context.source.source.password])}` : ''}`,
  );
}

async function commandOutput(result: VercelCommandResult): Promise<string> {
  const output: string[] = [];
  if (result.stdout) output.push(await result.stdout());
  if (result.stderr) output.push(await result.stderr());
  return output.join('\n').trim();
}

function createCleanupAdapter(client: VercelSandboxClient): VercelCleanupAdapter {
  return {
    get: (request) => client.get(request),
    listSessions: (sandbox, options) => client.listSessions(sandbox as VercelSandboxHandle, options),
    stop: (sandbox, options) => client.stopSandbox(sandbox as VercelSandboxHandle, options),
    listSnapshots: (request) => client.listSnapshots(request),
    getSnapshot: (request) => client.getSnapshot(request),
    delete: (sandbox, options) => client.deleteSandbox(sandbox as VercelSandboxHandle, options),
  };
}

function toMetadataIdentity(identity: VercelSandboxIdentity): VercelMetadataIdentity {
  return {
    name: identity.name,
    repository: identity.canonicalRepository,
    branch: identity.branch,
    packageVersion: identity.packageVersion,
    tags: {
      provider: identity.tags.provider,
      repository: identity.tags.repository,
      branch: identity.tags.branch,
      version: identity.tags.version,
      identity: identity.tags.identity,
    },
  };
}

function sameMetadataIdentity(actual: VercelMetadataIdentity, expected: VercelSandboxIdentity): boolean {
  return actual.name === expected.name &&
    actual.repository === expected.canonicalRepository &&
    actual.branch === expected.branch &&
    actual.packageVersion === expected.packageVersion &&
    sameTags(actual.tags, expected.tags);
}

type TagSet = {
  provider: string;
  repository: string;
  branch: string;
  version: string;
  identity: string;
};

function sameTags(actual: Record<string, string> | TagSet, expected: Readonly<Record<string, string>> | TagSet): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  const actualValues = actual as Record<string, string>;
  const expectedValues = expected as Readonly<Record<string, string>>;
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actualValues[key] === expectedValues[key]);
}

function sandboxIdentifier(sandbox: VercelSandboxHandle): string {
  const candidate = sandbox as VercelSandboxHandle & { id?: unknown };
  return typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : sandbox.name;
}

function allTerminal(sessions: SandboxSessionRecord[]): boolean {
  return sessions.every((session) => TERMINAL_STATES.has(session.status));
}

function isStoppableStatus(status: string): boolean {
  return ['pending', 'running', 'stopping', 'snapshotting'].includes(status);
}
