import { Command, CommandFinished, Sandbox, Snapshot } from '@vercel/sandbox';
import type { VercelCredentials } from './auth.js';
import { parseVercelImageReference } from './image.js';
import { assertSandboxVcpus } from './resources.js';
import type { GitSource } from './source.js';
import { redactSecrets } from './redaction.js';

export type SandboxSessionStatus =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'aborted'
  | 'snapshotting';

export type SandboxSnapshotStatus = 'failed' | 'created' | 'deleted';

export interface SandboxRoute {
  url: string;
  subdomain: string;
  port: number;
}

export interface SandboxSessionRecord {
  id: string;
  status: SandboxSessionStatus;
  sourceSnapshotId?: string;
  activeCpuDurationMs?: number;
  networkTransfer?: { ingress: number; egress: number };
  [key: string]: unknown;
}

export interface SandboxSnapshotRecord {
  id: string;
  sourceSessionId: string;
  status: SandboxSnapshotStatus;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface SandboxListRecord {
  name: string;
  persistent: boolean;
  status: SandboxSessionStatus;
  currentSessionId?: string;
  createdAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
  image?: string;
  timeout?: number;
  tags?: Record<string, string>;
  currentSnapshotId?: string;
  keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
  [key: string]: unknown;
}

export interface VercelStopResult {
  id: string;
  status: SandboxSessionStatus;
  activeCpuDurationMs?: number;
  networkTransfer?: { ingress: number; egress: number };
  snapshot?: {
    id: string;
    status: SandboxSnapshotStatus;
    sourceSessionId?: string;
    createdAt?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type VercelCommandResult = Command | CommandFinished;
export type VercelWriteFile = Parameters<Sandbox['writeFiles']>[0][number];
export type VercelRunCommandRequest = Parameters<Sandbox['runCommand']>[0];

export interface VercelInteractiveOptions {
  signal?: AbortSignal;
  sessionId?: string;
}

export interface VercelSandboxSession {
  readonly sessionId?: string;
  openInteractive(options?: { signal?: AbortSignal }): Promise<{ url: string; token: string }>;
  runCommand(params: VercelRunCommandRequest): Promise<VercelCommandResult>;
}

export interface VercelSandboxHandle {
  readonly id?: string;
  readonly name: string;
  readonly status: SandboxSessionStatus;
  readonly persistent?: boolean;
  readonly image?: string;
  readonly timeout?: number;
  readonly vcpus?: number;
  readonly createdAt?: Date;
  readonly expiresAt?: Date;
  readonly cwd?: string;
  readonly tags?: Record<string, string>;
  readonly routes?: readonly SandboxRoute[];
  readonly keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
  readonly currentSnapshotId?: string;
  /** Snapshot used to create the current session, when the session was resumed from one. */
  readonly sourceSnapshotId?: string;
  /** SDK 3 exposes the current session ID through this method, not `Sandbox.id`. */
  readonly currentSession?: () => VercelSandboxSession;
  readonly activeCpuUsageMs?: number;
  readonly networkTransfer?: { ingress: number; egress: number };
  readonly totalActiveCpuDurationMs?: number;
  readonly totalIngressBytes?: number;
  readonly totalEgressBytes?: number;
  openInteractive(options?: VercelInteractiveOptions): Promise<{ url: string; token: string }>;
  listSessions(params?: { signal?: AbortSignal }): Promise<unknown>;
  stop(params?: { signal?: AbortSignal }): Promise<VercelStopResult>;
  delete(params?: { signal?: AbortSignal }): Promise<void>;
  writeFiles(files: VercelWriteFile[], options?: { signal?: AbortSignal }): Promise<void>;
  runCommand(params: VercelRunCommandRequest): Promise<VercelCommandResult>;
  update(params: VercelSandboxUpdateRequest, options?: { signal?: AbortSignal }): Promise<void>;
  domain(port: number): string;
}

/**
 * The subset of `Sandbox.update` this client uses.
 *
 * `ports` is the complete desired list: the service deregisters any currently
 * exposed port that the array omits, so callers must always send the full set
 * rather than the delta they want to add.
 */
export type VercelSandboxUpdateRequest = Pick<Parameters<Sandbox['update']>[0], 'ports'>;

export interface VercelSnapshotHandle {
  readonly snapshotId: string;
  readonly status: SandboxSnapshotStatus;
  delete(params?: { signal?: AbortSignal }): Promise<void>;
}

export interface VercelSandboxCreateRequest {
  name: string;
  image: string;
  source: GitSource;
  timeout: number;
  ports?: number[];
  env?: Record<string, string>;
  persistent: true;
  keepLastSnapshots: { count: 1 };
  tags: Record<string, string>;
  resources?: { vcpus: number };
  signal?: AbortSignal;
  onCreate?: (sandbox: VercelSandboxHandle) => Promise<void>;
}

export interface VercelSandboxGetRequest {
  credentials: VercelCredentials;
  name: string;
  resume?: boolean;
  signal?: AbortSignal;
}

export interface VercelSandboxDeleteByNameRequest {
  credentials: VercelCredentials;
  name: string;
  signal?: AbortSignal;
}

export interface VercelSandboxDeleteByNameResult {
  missing: boolean;
}

export interface VercelSandboxCreateInput {
  name: string;
  /** Fully-qualified digest reference resolved for this run. */
  image: string;
  source: GitSource;
  timeoutMs: number;
  ports?: number[];
  runtimeEnvironment?: Record<string, string>;
  tags: Record<string, string>;
  vcpus?: number;
  signal?: AbortSignal;
  onCreate?: (sandbox: VercelSandboxHandle) => Promise<void>;
}

export function buildVercelSandboxCreateRequest(
  input: VercelSandboxCreateInput,
): VercelSandboxCreateRequest {
  if (!input.name.trim()) throw new Error('Vercel Sandbox name must not be empty');
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('Vercel Sandbox timeout must be positive');
  }
  if (input.vcpus !== undefined) {
    assertSandboxVcpus(input.vcpus);
  }
  // Throws unless the reference is fully qualified and digest-pinned.
  parseVercelImageReference(input.image);
  return {
    name: input.name,
    image: input.image,
    source: input.source,
    timeout: input.timeoutMs,
    ...(input.ports === undefined ? {} : { ports: [...input.ports] }),
    ...(input.runtimeEnvironment === undefined ? {} : { env: { ...input.runtimeEnvironment } }),
    persistent: true,
    keepLastSnapshots: { count: 1 },
    tags: { ...input.tags },
    ...(input.vcpus === undefined ? {} : { resources: { vcpus: input.vcpus } }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onCreate === undefined ? {} : { onCreate: input.onCreate }),
  };
}

export interface VercelSandboxClient {
  getOrCreate(request: VercelSandboxCreateRequest & { credentials: VercelCredentials }): Promise<VercelSandboxHandle>;
  get(request: VercelSandboxGetRequest): Promise<VercelSandboxHandle>;
  deleteSandboxByName(request: VercelSandboxDeleteByNameRequest): Promise<VercelSandboxDeleteByNameResult>;
  listSandboxes(request: {
    credentials: VercelCredentials;
    tags?: Record<string, string>;
    namePrefix?: string;
    signal?: AbortSignal;
  }): Promise<SandboxListRecord[]>;
  listSessions(
    sandbox: VercelSandboxHandle,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxSessionRecord[]>;
  stopSandbox(
    sandbox: VercelSandboxHandle,
    options?: { signal?: AbortSignal },
  ): Promise<VercelStopResult>;
  deleteSandbox(sandbox: VercelSandboxHandle, options?: { signal?: AbortSignal }): Promise<void>;
  writeFiles(
    sandbox: VercelSandboxHandle,
    files: VercelWriteFile[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  runCommand(
    sandbox: VercelSandboxHandle,
    params: VercelRunCommandRequest,
    options?: VercelRunCommandOptions,
  ): Promise<VercelCommandResult>;
  /**
   * Replace the Sandbox's exposed ports with `ports` on the running Sandbox.
   *
   * This never recreates the Sandbox: it is the only supported way to add an
   * app route to a box that is already up.
   */
  updatePorts(
    sandbox: VercelSandboxHandle,
    ports: readonly number[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  listSnapshots(request: {
    credentials: VercelCredentials;
    name: string;
    signal?: AbortSignal;
  }): Promise<SandboxSnapshotRecord[]>;
  getSnapshot(request: {
    credentials: VercelCredentials;
    snapshotId: string;
    signal?: AbortSignal;
  }): Promise<VercelSnapshotHandle>;
  deleteSnapshot(snapshot: VercelSnapshotHandle, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface VercelRunCommandOptions {
  expectedSessionId: string;
  secrets?: readonly string[];
}

export interface VercelSandboxApi {
  getOrCreate(params: Record<string, unknown>): Promise<VercelSandboxHandle>;
  get(params: Record<string, unknown>): Promise<VercelSandboxHandle>;
  list(params: Record<string, unknown>): Promise<unknown>;
}

export interface VercelSnapshotApi {
  list(params: Record<string, unknown>): Promise<unknown>;
  get(params: Record<string, unknown>): Promise<VercelSnapshotHandle>;
}

export interface VercelSandboxClientOptions {
  sandbox?: VercelSandboxApi;
  snapshot?: VercelSnapshotApi;
  fetch?: typeof globalThis.fetch;
}

export class VercelSdkError extends Error {
  readonly operation: string;
  readonly status?: number;
  readonly notFound: boolean;

  constructor(operation: string, error: unknown, secrets: readonly string[]) {
    const status = getStatus(error);
    super(redactSecrets(error instanceof Error ? error.message : String(error), secrets));
    this.name = 'VercelSdkError';
    this.operation = operation;
    this.status = status;
    this.notFound = status === 404;
  }
}

export function isVercelNotFound(error: unknown): boolean {
  if (error instanceof VercelSdkError) return error.notFound;
  const status = getStatus(error);
  if (status === 410) return false;
  return status === 404 || Boolean((error as { notFound?: unknown })?.notFound);
}

export function isVercelStale(error: unknown): boolean {
  return error instanceof VercelSdkError
    ? error.status === 410
    : getStatus(error) === 410;
}

const API_SAFE_SANDBOX_NAME_PREFIX_LENGTH = 32;

export function createVercelSandboxClient(
  options: VercelSandboxClientOptions = {},
): VercelSandboxClient {
  const sandboxApi = options.sandbox ?? (Sandbox as unknown as VercelSandboxApi);
  const snapshotApi = options.snapshot ?? (Snapshot as unknown as VercelSnapshotApi);
  const withFetch = (params: Record<string, unknown>): Record<string, unknown> => ({
    ...params,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  async function call<T>(operation: string, secrets: readonly string[], action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (isVercelLifecycleError(error)) throw error;
      throw new VercelSdkError(operation, error, secrets);
    }
  }

  return {
    getOrCreate: async (request) => {
      // The resolver decides which digest; the client only guarantees that a
      // digest is what reaches the SDK, so a floating tag can never create one.
      parseVercelImageReference(request.image);
      const { credentials, ...createRequest } = request;
      const sourcePassword = createRequest.source.password;
      const params = {
        ...createRequest,
        ...credentials,
        onCreate: createRequest.onCreate === undefined
          ? undefined
          : (sandbox: VercelSandboxHandle) => createRequest.onCreate!(wrapSandboxHandle(sandbox, [credentials.token, sourcePassword])),
      };
      return call('Sandbox.getOrCreate', [
        credentials.token,
        sourcePassword,
        ...Object.values(createRequest.env ?? {}),
      ], async () =>
        wrapSandboxHandle(await sandboxApi.getOrCreate(withFetch(params)), [
          credentials.token,
          sourcePassword,
          ...Object.values(createRequest.env ?? {}),
        ]),
      );
    },
    get: async (request) => {
      const { credentials, ...getRequest } = request;
      return call('Sandbox.get', [credentials.token], async () =>
        wrapSandboxHandle(await sandboxApi.get(withFetch({
          ...getRequest,
          ...credentials,
        })), [credentials.token]),
      );
    },
    deleteSandboxByName: async (request) => {
      const { credentials, name, signal } = request;
      return call('Sandbox.deleteByName', [credentials.token], async () => {
        const fetcher = options.fetch ?? globalThis.fetch;
        const url = `https://vercel.com/api/v2/sandboxes/${encodeURIComponent(name)}?teamId=${encodeURIComponent(credentials.teamId)}&projectId=${encodeURIComponent(credentials.projectId)}`;
        const response = await fetcher(url, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            'content-type': 'application/json',
          },
          signal,
        });
        if (response.status === 404) return { missing: true };
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw Object.assign(
            new Error(body || `Vercel Sandbox delete failed with status ${response.status}`),
            { status: response.status },
          );
        }
        return { missing: false };
      });
    },
    listSandboxes: async (request) => {
      const { credentials, tags, namePrefix, signal } = request;
      return call('Sandbox.list', [credentials.token, credentials.teamId, credentials.projectId], async () => {
        const serverNamePrefix = namePrefix?.slice(0, API_SAFE_SANDBOX_NAME_PREFIX_LENGTH);
        const page = await sandboxApi.list(withFetch({
          ...(serverNamePrefix === undefined ? {} : { namePrefix: serverNamePrefix }),
          ...credentials,
          ...(signal === undefined ? {} : { signal }),
          sortBy: 'name',
          sortOrder: 'asc',
          limit: 50,
        }));
        const sandboxes = await collectPaginated<SandboxListRecord>(page, 'sandboxes');
        return sandboxes.filter((sandbox) => matchesSandboxListFilters(sandbox, namePrefix, tags));
      });
    },
    listSessions: async (sandbox, options) => call(
      'Sandbox.listSessions',
      [],
      async () => collectPaginated<SandboxSessionRecord>(
        await sandbox.listSessions(options),
        'sessions',
      ),
    ),
    stopSandbox: async (sandbox, options) => call('Sandbox.stop', [], () => sandbox.stop(options)),
    deleteSandbox: async (sandbox, options) => call('Sandbox.delete', [], () => sandbox.delete(options)),
    writeFiles: async (sandbox, files, options) => call(
      'Sandbox.writeFiles',
      [],
      () => sandbox.writeFiles(files, options),
    ),
    runCommand: async (sandbox, params, options) => options === undefined
      ? call('Sandbox.runCommand', [], () => sandbox.runCommand(params))
      : runCurrentSessionCommand(sandbox, options.expectedSessionId, params, options.secrets),
    updatePorts: async (sandbox, ports, updateOptions) => call(
      'Sandbox.update',
      [],
      () => sandbox.update(
        { ports: [...ports] },
        updateOptions === undefined ? undefined : updateOptions,
      ),
    ),
    listSnapshots: async (request) => {
      const { credentials, ...listRequest } = request;
      return call('Snapshot.list', [credentials.token], async () => {
        const page = await snapshotApi.list(withFetch({
          ...listRequest,
          ...credentials,
          limit: 50,
        }));
        return collectPaginated<SandboxSnapshotRecord>(page, 'snapshots');
      });
    },
    getSnapshot: async (request) => {
      const { credentials, ...getRequest } = request;
      return call('Snapshot.get', [credentials.token], async () =>
        wrapSnapshotHandle(await snapshotApi.get(withFetch({
          ...getRequest,
          ...credentials,
        })), [credentials.token]),
      );
    },
    deleteSnapshot: async (snapshot, options) => call('Snapshot.delete', [], () => snapshot.delete(options)),
  };
}

/**
 * Run a command on the already materialized provider session.
 *
 * Sandbox.runCommand may transparently resume a stopped VM. Session.runCommand
 * keeps the command bound to the session that the caller observed, so teardown
 * cannot be undone by terminal or relay preparation.
 */
export function runCurrentSessionCommand(
  sandbox: VercelSandboxHandle,
  expectedSessionId: string,
  params: VercelRunCommandRequest,
  secrets: readonly string[] = [],
): Promise<VercelCommandResult> {
  return callWithSecrets('Session.runCommand', secrets, async () => {
    const session = sandbox.currentSession?.();
    if (!session?.runCommand) throw new Error('Vercel current session is unavailable for a strict command');
    if (session.sessionId !== expectedSessionId) {
      throw new Error('Vercel current session changed before a strict command started');
    }
    return session.runCommand(params);
  });
}

function matchesSandboxListFilters(
  sandbox: SandboxListRecord,
  namePrefix: string | undefined,
  tags: Record<string, string> | undefined,
): boolean {
  if (typeof sandbox?.name !== 'string') return false;
  if (namePrefix !== undefined && !sandbox.name.startsWith(namePrefix)) return false;
  if (tags !== undefined && Object.entries(tags).some(([key, value]) => sandbox.tags?.[key] !== value)) return false;
  return true;
}

function wrapSnapshotHandle(
  snapshot: VercelSnapshotHandle,
  secrets: readonly string[],
): VercelSnapshotHandle {
  return new Proxy(snapshot, {
    get(target, property, receiver) {
      if (property === 'delete') {
        return (options?: { signal?: AbortSignal }) => callWithSecrets(
          'Snapshot.delete',
          secrets,
          () => target.delete(options),
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function wrapSandboxHandle(
  handle: VercelSandboxHandle,
  secrets: readonly string[],
): VercelSandboxHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === 'openInteractive') {
        return (options?: VercelInteractiveOptions) => callWithSecrets(
          'Sandbox.openInteractive',
          secrets,
          async () => {
            const session = target.currentSession?.();
            if (!session?.openInteractive) {
              throw new Error('Vercel current session is unavailable for interactive terminal');
            }
            if (options?.sessionId !== undefined && session.sessionId !== options.sessionId) {
              throw new Error('Vercel current session changed before interactive terminal opened');
            }
            return session.openInteractive(options === undefined ? undefined : { signal: options.signal });
          },
        );
      }
      if (property === 'listSessions') {
        return (options?: { signal?: AbortSignal }) => callWithSecrets(
          'Sandbox.listSessions',
          secrets,
          () => target.listSessions(options),
        );
      }
      if (property === 'stop') {
        return (options?: { signal?: AbortSignal }) => callWithSecrets(
          'Sandbox.stop',
          secrets,
          () => target.stop(options),
        );
      }
      if (property === 'delete') {
        return (options?: { signal?: AbortSignal }) => callWithSecrets(
          'Sandbox.delete',
          secrets,
          () => target.delete(options),
        );
      }
      if (property === 'writeFiles') {
        return (files: VercelWriteFile[], options?: { signal?: AbortSignal }) => callWithSecrets(
          'Sandbox.writeFiles',
          secrets,
          () => target.writeFiles(files, options),
        );
      }
      if (property === 'runCommand') {
        return (params: VercelRunCommandRequest) => callWithSecrets(
          'Sandbox.runCommand',
          secrets,
          () => target.runCommand(params),
        );
      }
      if (property === 'update') {
        return (params: VercelSandboxUpdateRequest, options?: { signal?: AbortSignal }) => callWithSecrets(
          'Sandbox.update',
          secrets,
          () => target.update(params, options),
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function callWithSecrets<T>(
  operation: string,
  secrets: readonly string[],
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isVercelLifecycleError(error)) throw error;
    throw new VercelSdkError(operation, error, secrets);
  }
}

function isVercelLifecycleError(error: unknown): boolean {
  return error instanceof Error &&
    error.name === 'VercelLifecycleError' &&
    typeof (error as { code?: unknown }).code === 'string';
}

export async function collectPaginated<T>(value: unknown, key: string): Promise<T[]> {
  if (Array.isArray(value)) return value as T[];
  const candidate = value as {
    toArray?: () => Promise<unknown[]>;
    pages?: () => AsyncIterable<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    [key: string]: unknown;
  } | null;
  if (!candidate) throw new Error(`Vercel SDK pagination for ${key} returned no page`);
  if (typeof candidate.toArray === 'function') return (await candidate.toArray()) as T[];
  if (typeof candidate[Symbol.asyncIterator] === 'function') {
    const items: T[] = [];
    for await (const item of candidate as AsyncIterable<unknown>) items.push(item as T);
    return items;
  }
  if (typeof candidate.pages === 'function') {
    const items: T[] = [];
    for await (const page of candidate.pages()) {
      const pageItems = (page as Record<string, unknown>)[key];
      if (Array.isArray(pageItems)) items.push(...(pageItems as T[]));
    }
    return items;
  }
  const items = candidate[key];
  if (Array.isArray(items)) return items as T[];
  throw new Error(`Vercel SDK pagination for ${key} is not iterable`);
}

function getStatus(error: unknown): number | undefined {
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  } | null;
  if (typeof candidate?.status === 'number') return candidate.status;
  if (typeof candidate?.response?.status === 'number') return candidate.response.status;
  return undefined;
}
