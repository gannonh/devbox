import type { CredentialResolutionOptions, VercelCredentials } from './auth.js';
import { resolveVercelCredentials } from './auth.js';
import {
  cleanupVercelSandbox,
  STOPPABLE_SESSION_STATES,
  TERMINAL_SESSION_STATES,
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
import { matchesVercelSandboxImageDigest, parseVercelImageReference } from './image.js';
import { resolveVercelImage } from './image-resolution.js';
import { createVcrChannelResolver } from './image-registry.js';
import { createVercelIdentity, createVercelRepositoryTag, type VercelSandboxIdentity } from './identity.js';
import {
  type VercelBranchMetadata,
  type VercelBranchMetadataInput,
  type VercelBranchMetadataStore,
  type VercelCreateConfiguration,
  type VercelMetadataIdentity,
} from './metadata.js';
import {
  normalizeRequestedSourceBranch,
  renderRemoteSourceNotice,
  resolveGitHubSource,
  resolveVercelRepositoryCwd,
  type GitHubSourcePlan,
} from './source.js';
import { redactSecrets } from './redaction.js';
import { assertSdkPorts, resolveDevcontainerPorts } from './ports.js';
import type { ShellRunner } from '../../lib/shell.js';

export const DEFAULT_VERCEL_SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;
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

  constructor(
    result: VercelCleanupResult,
    message = `Vercel Sandbox cleanup is incomplete; retry is required${
      result.errors.length > 0 ? `: ${result.errors.join('; ')}` : ''
    }`,
  ) {
    super(
      'cleanup_incomplete',
      message,
    );
    this.name = 'VercelCleanupError';
    this.result = result;
  }
}

export class VercelRecoveryCleanupError extends VercelCleanupError {
  readonly recoveryMetadataFailure?: string;

  constructor(
    result: VercelCleanupResult,
    message: string,
    recoveryMetadataFailure?: string,
  ) {
    super(result, message);
    this.name = 'VercelRecoveryCleanupError';
    if (recoveryMetadataFailure !== undefined) this.recoveryMetadataFailure = recoveryMetadataFailure;
  }
}

export class VercelCreationCompensationError extends VercelCleanupError {
  readonly creationFailure: string;
  readonly recoveryMetadataFailure?: string;

  constructor(
    result: VercelCleanupResult,
    creationFailure: string,
    recoveryMetadataFailure?: string,
  ) {
    const residuals = [
      ...result.residualSandboxIds,
      ...result.residualSnapshotIds,
    ];
    super(
      result,
      `Vercel Sandbox creation metadata persistence failed; compensation is incomplete` +
        `${residuals.length > 0 ? `; recover resource IDs: ${residuals.join(', ')}` : ''}` +
        `${recoveryMetadataFailure === undefined ? '' : `; recovery metadata was not retained: ${recoveryMetadataFailure}`}`,
    );
    this.name = 'VercelCreationCompensationError';
    this.creationFailure = creationFailure;
    if (recoveryMetadataFailure !== undefined) this.recoveryMetadataFailure = recoveryMetadataFailure;
  }
}

export interface VercelLifecycleOptions {
  repoRoot: string;
  /**
   * Resolve the Sandbox image reference. Defaults to the release pin when the
   * package carries one and the nightly channel otherwise; injected by tests so
   * they never reach the registry.
   */
  resolveImage?: () => Promise<string>;
  branch?: string;
  packageVersion?: string;
  ports?: number[];
  env?: Record<string, string | undefined>;
  runtimeEnvironment?: Record<string, string>;
  credentials?: VercelCredentials;
  credentialOptions?: Omit<CredentialResolutionOptions, 'repoRoot' | 'env'>;
  source?: GitHubSourcePlan;
  sourceResolver?: () => Promise<GitHubSourcePlan>;
  shellRunner?: ShellRunner;
  branchMetadataStore?: VercelBranchMetadataStore;
  /** List is repository-scoped and must not read an invented branch record. */
  listOnly?: boolean;
  stateHome?: string;
  repoKey?: string;
  repository?: string;
  /** Authoritative live-resource identity used when branch metadata is unavailable. */
  recovery?: VercelRecoveryInput;
  client?: VercelSandboxClient;
  timeoutMs?: number;
  vcpus?: number;
  onNotice?: (notice: string) => void | Promise<void>;
  cleanup?: Pick<VercelCleanupOptions, 'timeoutMs' | 'maxAttempts' | 'backoffMs' | 'sleep'>;
}

export interface VercelRecoveryInput {
  identity: VercelMetadataIdentity;
  snapshotIds?: readonly string[];
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
  env: Record<string, string | undefined>;
  runtimeEnvironment?: Record<string, string>;
  source?: GitHubSourcePlan;
  identity?: VercelSandboxIdentity;
  repository: string;
  repositoryTag: string;
  metadataStore?: VercelBranchMetadataStore;
  client: VercelSandboxClient;
  imageReference: string;
  timeoutMs: number;
  vcpus?: number;
  configuration?: VercelCreateConfiguration;
}

export function createVercelLifecycle(options: VercelLifecycleOptions): VercelLifecycle {
  let contextPromise: Promise<PreparedContext> | undefined;
  let portsPromise: Promise<number[]> | undefined;
  const getContext = (): Promise<PreparedContext> => {
    contextPromise ??= prepareContext(options);
    return contextPromise;
  };
  const getPorts = (): Promise<number[]> => {
    portsPromise ??= resolvePorts(options);
    return portsPromise;
  };

  return {
    up: async () => {
      const context = await getContext();
      const ports = await getPorts();
      const metadataStore = requireMetadataStore(context);
      const identity = requireIdentity(context);
      const source = requireSource(context);
      const configuration = requireConfiguration(context);
      return metadataStore.withLock(async () => {
        const existing = await metadataStore.read();
        if (!existing) await options.onNotice?.(source.warning || renderRemoteSourceNotice());
        assertScopeAndIdentity(existing, context);
        if (existing?.configuration) assertConfiguration(existing.configuration, configuration);

        const effectiveIdentity = existing?.identity ?? toMetadataIdentity(identity);
        let createdSandbox: VercelSandboxHandle | undefined;
        const createRequest = buildVercelSandboxCreateRequest({
          name: effectiveIdentity.name,
          image: context.imageReference,
          source: source.source,
          timeoutMs: context.timeoutMs,
          ports,
          tags: { ...effectiveIdentity.tags },
          ...(context.runtimeEnvironment === undefined ? {} : { runtimeEnvironment: context.runtimeEnvironment }),
          ...(context.vcpus === undefined ? {} : { vcpus: context.vcpus }),
          onCreate: async (sandbox) => {
            createdSandbox = sandbox;
            await switchToRequestedBranch(sandbox, context);
          },
        });
        let sandbox: VercelSandboxHandle;
        try {
          sandbox = await context.client.getOrCreate({
            credentials: context.credentials,
            ...createRequest,
          });
          validateSandboxIdentity(sandbox, context, effectiveIdentity);
          await writeBranchMetadata(context, {
            identity: effectiveIdentity,
            sandboxId: sandboxIdentifier(sandbox),
            ...(existing?.snapshotIds === undefined ? {} : { snapshotIds: existing.snapshotIds }),
            ...(existing?.residual === undefined ? {} : { residual: existing.residual }),
            ...preserveDisplayCredentials(existing),
            configuration: existing?.configuration ?? configuration,
          });
        } catch (error) {
          if (createdSandbox === undefined) throw error;
          return handleCreatedSandboxFailure(
            context,
            metadataStore,
            effectiveIdentity,
            createdSandbox,
            existing,
            configuration,
            error,
            options.cleanup,
          );
        }
        return sandbox;
      });
    },
    get: async (request = {}) => {
      const context = await getContext();
      const metadataStore = requireMetadataStore(context);
      return metadataStore.withLock(async () => {
        const metadata = await metadataStore.read();
        const identity = requireStoredIdentity(metadata, context);
        const sandbox = await getExistingSandbox(context, context.credentials, identity.name, request.resume ?? true);
        validateSandboxIdentity(sandbox, context, identity);
        return sandbox;
      });
    },
    attach: async () => {
      const context = await getContext();
      const metadataStore = requireMetadataStore(context);
      return metadataStore.withLock(async () => {
        const metadata = await metadataStore.read();
        const identity = requireStoredIdentity(metadata, context);
        const sandbox = await getExistingSandbox(context, context.credentials, identity.name, true);
        validateSandboxIdentity(sandbox, context, identity);
        return sandbox;
      });
    },
    list: async () => {
      const context = await getContext();
      if (options.listOnly) {
        const records = await context.client.listSandboxes({
          credentials: context.credentials,
          tags: { provider: 'vercel', repository: context.repositoryTag },
        });
        return records.filter((record) => isValidGlobalListIdentityTags(
          record.tags,
          'vercel',
          context.repositoryTag,
        ));
      }
      const metadataStore = requireMetadataStore(context);
      return metadataStore.withLock(async () => {
        const metadata = await metadataStore.read();
        if (metadata) assertScopeAndIdentity(metadata, context);
        const identity = metadata?.identity ?? toMetadataIdentity(requireIdentity(context));
        const records = await context.client.listSandboxes({
          credentials: context.credentials,
          tags: {
            provider: identity.tags.provider,
            repository: identity.tags.repository,
          },
        });
        return records.filter((record) => isValidGlobalListIdentityTags(
          record.tags,
          identity.tags.provider,
          identity.tags.repository,
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
      const metadataStore = requireMetadataStore(context);
      const configuration = requireConfiguration(context);
      return metadataStore.withLock(async () => {
        const metadata = await metadataStore.read();
        const identity = requireStoredIdentity(metadata, context);
        if (metadata?.configuration) assertConfiguration(metadata.configuration, configuration);
        const effectiveConfiguration = metadata?.configuration ?? configuration;
        const sandbox = await getExistingSandbox(context, context.credentials, identity.name, false);
        validateSandboxIdentity(sandbox, context, identity);
        let sessions = await context.client.listSessions(sandbox);
        let finalStop: VercelStopResult | undefined;
        if (!allTerminal(sessions) || STOPPABLE_SESSION_STATES.has(sandbox.status)) {
          finalStop = await context.client.stopSandbox(sandbox);
          sessions = await context.client.listSessions(sandbox);
        }
        if (!allTerminal(sessions)) {
          throw new VercelLifecycleError('stop_incomplete', 'Vercel Sandbox still has a non-terminal session');
        }
        const snapshot = finalStop?.snapshot;
        const knownSnapshotIds = [
          ...new Set([
            ...(metadata?.snapshotIds ?? []),
            ...(metadata?.residual?.snapshotIds ?? []),
            ...(snapshot === undefined ? [] : [snapshot.id]),
          ]),
        ];
        await writeBranchMetadata(context, {
          identity,
          sandboxId: sandboxIdentifier(sandbox),
          ...(knownSnapshotIds.length === 0 ? {} : { snapshotIds: knownSnapshotIds }),
          ...(metadata?.residual === undefined ? {} : { residual: metadata.residual }),
          ...preserveDisplayCredentials(metadata),
          configuration: effectiveConfiguration,
        });
        const finalSession = selectNewestSession(sessions);
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
      if (options.recovery) {
        return removeRecoveredSandbox(context, options.recovery, options.cleanup);
      }
      const metadataStore = requireMetadataStore(context);
      const configuration = requireConfiguration(context);
      return metadataStore.withLock(async () => {
        const metadata = await metadataStore.read();
        if (metadata) assertScopeAndIdentity(metadata, context);
        const identity = metadata?.identity ?? toMetadataIdentity(requireIdentity(context));
        const adapter = createCleanupAdapter(context.client);
        const result = await cleanupVercelSandbox({
          name: identity.name,
          credentials: context.credentials,
          expectedTags: identity.tags,
          knownSnapshotIds: [
            ...new Set([
              ...(metadata?.snapshotIds ?? []),
              ...(metadata?.residual?.snapshotIds ?? []),
            ]),
          ],
          adapter,
          ...(options.cleanup ?? {}),
        });
        if (result.verified) {
          await metadataStore.remove();
          return result;
        }
        const cleanupDetails = result.errors.map((error) => redactLifecycleFailure(
          error,
          lifecycleSecrets(context, metadata),
        ));
        await writeBranchMetadata(context, {
          identity,
          sandboxId: metadata?.sandboxId ?? identity.name,
          ...(metadata?.snapshotIds === undefined ? {} : { snapshotIds: metadata.snapshotIds }),
          ...preserveDisplayCredentials(metadata),
          configuration: metadata?.configuration ?? configuration,
          residual: {
            sandboxIds: result.residualSandboxIds,
            snapshotIds: result.residualSnapshotIds,
            reason: cleanupDetails.join('; ') || 'Vercel cleanup verification did not converge',
          },
        });
        throw new VercelCleanupError(
          result,
          cleanupDetails.join('; ') || 'Vercel cleanup verification did not converge',
        );
      });
    },
  };
}

async function removeRecoveredSandbox(
  context: PreparedContext,
  recovery: VercelRecoveryInput,
  cleanupOptions: VercelLifecycleOptions['cleanup'],
): Promise<VercelCleanupResult> {
  const result = await cleanupVercelSandbox({
    name: recovery.identity.name,
    credentials: context.credentials,
    expectedTags: recovery.identity.tags,
    ...(recovery.snapshotIds === undefined ? {} : { knownSnapshotIds: recovery.snapshotIds }),
    adapter: createCleanupAdapter(context.client),
    ...(cleanupOptions ?? {}),
  });
  if (result.verified) {
    try {
      await context.metadataStore?.remove();
    } catch {
      // Cloud cleanup is authoritative; local recovery state is best effort.
    }
    return result;
  }

  let existingMetadata: VercelBranchMetadata | null = null;
  let secrets = lifecycleSecrets(context);
  const residualSandboxIds = [...new Set(result.residualSandboxIds)];
  const residualSnapshotIds = [...new Set(result.residualSnapshotIds)];
  let cleanupDetails = result.errors.map((error) => redactLifecycleFailure(error, secrets));
  let recoveryMetadataFailure: string | undefined;
  const persistRecoveryMetadata = async (): Promise<void> => {
    try {
      existingMetadata = await context.metadataStore!.read();
    } catch {
      // Cloud recovery remains authoritative when local metadata cannot be read.
    }
    secrets = lifecycleSecrets(context, existingMetadata);
    cleanupDetails = result.errors.map((error) => redactLifecycleFailure(error, secrets));
    try {
      await writeBranchMetadata(context, {
        identity: recovery.identity,
        sandboxId: recovery.identity.name,
        ...(result.snapshotIds.length === 0 ? {} : { snapshotIds: result.snapshotIds }),
        ...preserveDisplayCredentials(existingMetadata),
        residual: {
          ...(residualSandboxIds.length === 0 ? {} : { sandboxIds: residualSandboxIds }),
          ...(residualSnapshotIds.length === 0 ? {} : { snapshotIds: residualSnapshotIds }),
          reason: [
            'authoritative recovered cleanup did not verify',
            ...(cleanupDetails.length === 0 ? [] : cleanupDetails),
          ].join('; '),
        },
      });
    } catch (error) {
      recoveryMetadataFailure = redactLifecycleFailure(error, secrets);
    }
  };
  try {
    if (!context.metadataStore) throw new Error('Vercel branch metadata store is required');
    await context.metadataStore.withLock(persistRecoveryMetadata);
  } catch (error) {
    recoveryMetadataFailure ??= redactLifecycleFailure(error, secrets);
  }

  const residualIds = [...residualSandboxIds, ...residualSnapshotIds];
  const residualDetail = residualIds.length === 0 ? '' : ` Residual resource IDs: ${residualIds.join(', ')}.`;
  const cleanupDetail = cleanupDetails.length === 0 ? '' : ` Cleanup details: ${cleanupDetails.join('; ')}.`;
  const metadataDetail = recoveryMetadataFailure === undefined
    ? ' Recovery metadata was retained for retry.'
    : ` Recovery metadata persistence failed: ${recoveryMetadataFailure}.`;
  throw new VercelRecoveryCleanupError(
    result,
    `Vercel recovered Sandbox cleanup is incomplete.${residualDetail}${metadataDetail}${cleanupDetail}`,
    recoveryMetadataFailure,
  );
}

function preserveDisplayCredentials(
  metadata: VercelBranchMetadata | null | undefined,
): Pick<VercelBranchMetadataInput, 'displayCredentials'> {
  return metadata?.displayCredentials === undefined
    ? {}
    : { displayCredentials: metadata.displayCredentials };
}

async function writeBranchMetadata(
  context: PreparedContext,
  metadata: VercelBranchMetadataInput,
): Promise<void> {
  await requireMetadataStore(context).write(metadata);
}

interface CreatedSandboxCompensation {
  result: VercelCleanupResult;
  creationFailure: string;
  recoveryMetadataFailure?: string;
}

async function handleCreatedSandboxFailure(
  context: PreparedContext,
  metadataStore: VercelBranchMetadataStore,
  identity: VercelMetadataIdentity,
  createdSandbox: VercelSandboxHandle,
  existing: VercelBranchMetadata | null,
  configuration: VercelCreateConfiguration,
  creationError: unknown,
  cleanupOptions: VercelLifecycleOptions['cleanup'],
): Promise<never> {
  const compensation = await compensateCreatedSandbox(
    context,
    identity,
    createdSandbox,
    existing,
    configuration,
    creationError,
    cleanupOptions,
  );
  if (compensation.result.verified) {
    if (!existing) {
      try {
        await metadataStore.remove();
      } catch {
        // The resource is already verified absent; retain the original
        // persistence failure and let the next up repair metadata.
      }
    }
    throw creationError;
  }
  throw new VercelCreationCompensationError(
    compensation.result,
    compensation.creationFailure,
    compensation.recoveryMetadataFailure,
  );
}

async function compensateCreatedSandbox(
  context: PreparedContext,
  identity: VercelMetadataIdentity,
  createdSandbox: VercelSandboxHandle,
  existing: VercelBranchMetadata | null,
  configuration: VercelCreateConfiguration,
  creationError: unknown,
  cleanupOptions: VercelLifecycleOptions['cleanup'],
): Promise<CreatedSandboxCompensation> {
  const secrets = lifecycleSecrets(context, existing);
  const creationFailure = redactLifecycleFailure(creationError, secrets);
  const knownSnapshotIds = [
    ...new Set([
      ...(existing?.snapshotIds ?? []),
      ...(existing?.residual?.snapshotIds ?? []),
      ...(createdSandbox.currentSnapshotId === undefined ? [] : [createdSandbox.currentSnapshotId]),
    ]),
  ];
  let result: VercelCleanupResult;
  try {
    result = await cleanupVercelSandbox({
      name: identity.name,
      credentials: context.credentials,
      expectedTags: identity.tags,
      knownSnapshotIds,
      adapter: createCleanupAdapter(context.client),
      ...(cleanupOptions ?? {}),
    });
  } catch (error) {
    const detail = redactLifecycleFailure(error, secrets);
    const snapshotIds = createdSandbox.currentSnapshotId === undefined
      ? []
      : [createdSandbox.currentSnapshotId];
    result = {
      verified: false,
      sandboxDeleted: false,
      snapshotsCleaned: false,
      sandboxMissing: false,
      snapshotIds,
      residualSandboxIds: [sandboxIdentifier(createdSandbox)],
      residualSnapshotIds: snapshotIds,
      finalSessions: [],
      errors: [`compensation: ${detail}`],
    };
  }
  if (result.verified) return { result, creationFailure };

  let recoveryMetadataFailure: string | undefined;
  const cleanupDetails = result.errors.map((error) => redactLifecycleFailure(error, secrets));
  try {
    await writeBranchMetadata(context, {
      identity,
      sandboxId: sandboxIdentifier(createdSandbox),
      ...(result.snapshotIds.length === 0 ? {} : { snapshotIds: result.snapshotIds }),
      ...preserveDisplayCredentials(existing),
      configuration: existing?.configuration ?? configuration,
      residual: {
        ...(result.residualSandboxIds.length === 0 ? {} : { sandboxIds: result.residualSandboxIds }),
        ...(result.residualSnapshotIds.length === 0 ? {} : { snapshotIds: result.residualSnapshotIds }),
        reason: [
          `Sandbox creation metadata persistence failed: ${creationFailure}`,
          'compensation did not verify cleanup',
          ...(cleanupDetails.length === 0 ? [] : cleanupDetails),
        ].join('; '),
      },
    });
  } catch (error) {
    recoveryMetadataFailure = redactLifecycleFailure(error, secrets);
  }
  return {
    result,
    creationFailure,
    ...(recoveryMetadataFailure === undefined ? {} : { recoveryMetadataFailure }),
  };
}

function lifecycleSecrets(
  context: PreparedContext,
  metadata?: VercelBranchMetadata | null,
): string[] {
  return [
    context.credentials.token,
    context.source?.source.password,
    context.env.GH_TOKEN,
    context.env.GITHUB_TOKEN,
    context.env.VERCEL_TOKEN,
    context.env.VERCEL_OIDC_TOKEN,
    metadata?.displayCredentials?.password,
    ...(context.runtimeEnvironment === undefined ? [] : Object.values(context.runtimeEnvironment)),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function redactLifecycleFailure(error: unknown, secrets: readonly string[]): string {
  return redactSecrets(error, secrets).replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function resolvePorts(options: VercelLifecycleOptions): Promise<number[]> {
  return options.ports === undefined
    ? (await resolveDevcontainerPorts(options.repoRoot)).ports
    : assertSdkPorts([...options.ports]);
}

async function prepareContext(options: VercelLifecycleOptions): Promise<PreparedContext> {
  const source = options.source
    ?? (options.listOnly
      ? undefined
      : options.sourceResolver
        ? await options.sourceResolver()
        : await resolveGitHubSource({
          repoRoot: options.repoRoot,
          branch: options.branch ?? (() => { throw new Error('Vercel lifecycle branch is required'); })(),
          env: options.env,
          shellRunner: options.shellRunner,
        }));
  const repository = options.repository ?? source?.remote.canonical ?? options.repoKey;
  if (!repository) throw new Error('Vercel lifecycle repository is required');
  const packageVersion = options.packageVersion ?? undefined;
  const credentials = options.credentials
    ?? await resolveVercelCredentials({
      repoRoot: options.repoRoot,
      env: options.env,
      ...options.credentialOptions,
    });
  const identity = options.listOnly || !source
    ? undefined
    : createVercelIdentity({
      remote: source.remote.canonical,
      branch: source.requestedBranch,
      ...(packageVersion === undefined ? {} : { packageVersion }),
      ...(options.branchMetadataStore === undefined
        ? {}
        : { scope: { teamId: credentials.teamId, projectId: credentials.projectId } }),
    });
  const imageReference = options.resolveImage
    ? await options.resolveImage()
    : (await resolveVercelImage({
      env: options.env ?? {},
      credentials,
      resolveChannel: createVcrChannelResolver(),
    })).reference;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERCEL_SANDBOX_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Vercel Sandbox timeout must be positive');
  }
  if (options.vcpus !== undefined && (!Number.isInteger(options.vcpus) || options.vcpus <= 0)) {
    throw new Error('Vercel Sandbox vcpus must be a positive integer');
  }
  const metadataStore = options.listOnly ? undefined : options.branchMetadataStore;
  const client = options.client;
  if (!client) throw new Error('Vercel Sandbox client is required');
  return {
    credentials,
    env: options.env ?? {},
    ...(options.runtimeEnvironment === undefined ? {} : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(source === undefined ? {} : { source }),
    ...(identity === undefined ? {} : { identity }),
    repository,
    repositoryTag: createVercelRepositoryTag(repository),
    metadataStore,
    client,
    imageReference,
    timeoutMs,
    ...(options.vcpus === undefined ? {} : { vcpus: options.vcpus }),
    ...(source === undefined ? {} : {
      configuration: {
        imageReference,
        sourceUrl: source.source.url,
        sourceRevision: source.source.revision,
        requestedBranch: source.requestedBranch,
        needsBranchSetup: source.needsBranchSetup,
        persistent: true as const,
        keepLastSnapshots: 1 as const,
        timeoutMs,
        ...(options.vcpus === undefined ? {} : { vcpus: options.vcpus }),
      },
    }),
  };
}

function requireMetadataStore(context: PreparedContext): VercelBranchMetadataStore {
  if (!context.metadataStore) throw new Error('Vercel branch metadata store is required for this operation');
  return context.metadataStore;
}

function requireIdentity(context: PreparedContext): VercelSandboxIdentity {
  if (!context.identity) throw new Error('Vercel sandbox identity is unavailable for this operation');
  return context.identity;
}

function requireSource(context: PreparedContext): GitHubSourcePlan {
  if (!context.source) throw new Error('Vercel source is unavailable for this operation');
  return context.source;
}

function requireConfiguration(context: PreparedContext): VercelCreateConfiguration {
  if (!context.configuration) throw new Error('Vercel create configuration is unavailable for this operation');
  return context.configuration;
}

async function getExistingForOperation(
  getContext: () => Promise<PreparedContext>,
): Promise<VercelSandboxHandle> {
  const context = await getContext();
  const metadataStore = requireMetadataStore(context);
  return metadataStore.withLock(async () => {
    const metadata = await metadataStore.read();
    const identity = requireStoredIdentity(metadata, context);
    const sandbox = await getExistingSandbox(context, context.credentials, identity.name, true);
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
  metadata: VercelBranchMetadata | null,
  context: PreparedContext,
): VercelMetadataIdentity {
  if (!metadata) throw new VercelResourceNotFoundError('metadata record', context.repository);
  assertScopeAndIdentity(metadata, context);
  if (!metadata.identity) {
    throw new VercelLifecycleError('metadata_incomplete', 'Vercel metadata does not contain sandbox identity');
  }
  return metadata.identity;
}

function assertScopeAndIdentity(
  metadata: VercelBranchMetadata | null,
  context: PreparedContext,
): void {
  if (!metadata) return;
  if (metadata.identity && context.identity) {
    const expectedStoredIdentity = createVercelIdentity({
      remote: context.identity.canonicalRepository,
      branch: context.identity.branch,
      packageVersion: metadata.identity.packageVersion,
      scope: { teamId: context.credentials.teamId, projectId: context.credentials.projectId },
    });
    if (!sameMetadataIdentity(metadata.identity, expectedStoredIdentity)) {
      throw new VercelIdentityConflictError('Stored Vercel Sandbox identity does not match this repository and branch');
    }
  }
}

function assertConfiguration(
  actual: VercelCreateConfiguration,
  expected: VercelCreateConfiguration,
): void {
  if (
    actual.imageReference !== expected.imageReference ||
    actual.sourceUrl !== expected.sourceUrl ||
    actual.persistent !== expected.persistent ||
    actual.keepLastSnapshots !== expected.keepLastSnapshots ||
    actual.timeoutMs !== expected.timeoutMs ||
    actual.vcpus !== expected.vcpus
  ) {
    throw new VercelIdentityConflictError('Stored Vercel Sandbox create-only configuration conflicts with this request');
  }
}

function validateSandboxIdentity(
  sandbox: VercelSandboxHandle,
  context: PreparedContext,
  storedIdentity?: VercelMetadataIdentity,
): void {
  const expectedIdentity = storedIdentity ?? requireIdentity(context);
  const expectedName = expectedIdentity.name;
  const expectedTags = expectedIdentity.tags;
  if (sandbox.name !== expectedName) {
    throw new VercelIdentityConflictError(`Vercel Sandbox name conflict for ${expectedName}`);
  }
  if (!sandbox.tags || !sameTags(sandbox.tags, expectedTags)) {
    throw new VercelIdentityConflictError(`Vercel Sandbox tags conflict for ${expectedName}`);
  }
  const expectedImageDigest = parseVercelImageReference(context.imageReference).digest;
  if (!matchesVercelSandboxImageDigest(sandbox.image, expectedImageDigest)) {
    throw new VercelIdentityConflictError(`Vercel Sandbox image digest conflicts for ${expectedName}`);
  }
  if (sandbox.timeout !== undefined && sandbox.timeout !== context.timeoutMs) {
    throw new VercelIdentityConflictError(`Vercel Sandbox timeout conflicts for ${expectedName}`);
  }
  if (context.vcpus !== undefined && sandbox.vcpus !== undefined && sandbox.vcpus !== context.vcpus) {
    throw new VercelIdentityConflictError(`Vercel Sandbox resources conflict for ${expectedName}`);
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
  const source = requireSource(context);
  const result = await context.client.runCommand(sandbox, {
    cmd: 'git',
    args: ['switch', '--force-create', source.requestedBranch, '--'],
    cwd: resolveVercelRepositoryCwd(sandbox.cwd, source.remote.repository),
  });
  if (result.exitCode === 0) return;
  const output = await commandOutput(result);
  throw new VercelLifecycleError(
    'branch_setup_failed',
    `Unable to create requested Git branch ${source.requestedBranch}${output ? `: ${redactSecrets(output, [source.source.password])}` : ''}`,
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
    deleteByName: (request) => client.deleteSandboxByName(request),
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

function isValidGlobalListIdentityTags(
  tags: Record<string, string> | undefined,
  expectedProvider: string,
  expectedRepository: string,
): boolean {
  if (!tags) return false;
  const expectedKeys = ['provider', 'repository', 'branch', 'version', 'identity'];
  const actualKeys = Object.keys(tags).sort();
  if (actualKeys.length !== expectedKeys.length ||
      !actualKeys.every((key, index) => key === [...expectedKeys].sort()[index])) {
    return false;
  }
  if (tags.provider !== expectedProvider || tags.repository !== expectedRepository) return false;
  try {
    normalizeRequestedSourceBranch(tags.branch);
  } catch {
    return false;
  }
  return isValidTagValue(tags.version) && isValidTagValue(tags.identity);
}

function isValidTagValue(value: string): boolean {
  return value.trim().length > 0 && [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f && !/\s/.test(character);
  });
}

function sameTags(actual: Record<string, string> | TagSet, expected: Readonly<Record<string, string>> | TagSet): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  const actualValues = actual as Record<string, string>;
  const expectedValues = expected as Readonly<Record<string, string>>;
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actualValues[key] === expectedValues[key]);
}

export function sandboxIdentifier(sandbox: VercelSandboxHandle): string {
  const candidate = sandbox as VercelSandboxHandle & { id?: unknown };
  return typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : sandbox.name;
}

function selectNewestSession(sessions: SandboxSessionRecord[]): SandboxSessionRecord | undefined {
  return sessions.reduce<SandboxSessionRecord | undefined>((newest, session) => {
    if (!newest) return session;
    const comparison = compareSessionOrder(session, newest);
    return comparison > 0 ? session : newest;
  }, undefined);
}

function compareSessionOrder(left: SandboxSessionRecord, right: SandboxSessionRecord): number {
  for (const field of ['requestedAt', 'createdAt', 'updatedAt'] as const) {
    const leftValue = numericSessionField(left, field);
    const rightValue = numericSessionField(right, field);
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return left.id.localeCompare(right.id);
}

function numericSessionField(
  session: SandboxSessionRecord,
  field: 'requestedAt' | 'createdAt' | 'updatedAt',
): number {
  const value = session[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function allTerminal(sessions: SandboxSessionRecord[]): boolean {
  return sessions.every((session) => TERMINAL_SESSION_STATES.has(session.status));
}
