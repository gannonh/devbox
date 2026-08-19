import { Command, CommandFinished, Sandbox, Snapshot } from '@vercel/sandbox';
import type { VercelCredentials } from './auth.js';
import { parseVercelImageReference } from './image.js';
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
  activeCpuDurationMs?: number;
  networkTransfer?: { ingress: number; egress: number };
  [key: string]: unknown;
}

export interface SandboxSnapshotRecord {
  id: string;
  sourceSessionId: string;
  status: SandboxSnapshotStatus;
  [key: string]: unknown;
}

export interface SandboxListRecord {
  name: string;
  persistent: boolean;
  status: SandboxSessionStatus;
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
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type VercelCommandResult = Command | CommandFinished;
export type VercelWriteFile = Parameters<Sandbox['writeFiles']>[0][number];
export type VercelRunCommandRequest = Parameters<Sandbox['runCommand']>[0];

export interface VercelSandboxHandle {
  readonly id?: string;
  readonly name: string;
  readonly status: SandboxSessionStatus;
  readonly persistent?: boolean;
  readonly image?: string;
  readonly timeout?: number;
  readonly createdAt?: Date;
  readonly expiresAt?: Date;
  readonly cwd?: string;
  readonly tags?: Record<string, string>;
  readonly routes?: readonly SandboxRoute[];
  readonly keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
  readonly currentSnapshotId?: string;
  readonly activeCpuUsageMs?: number;
  readonly networkTransfer?: { ingress: number; egress: number };
  readonly totalActiveCpuDurationMs?: number;
  readonly totalIngressBytes?: number;
  readonly totalEgressBytes?: number;
  openInteractive(options?: { signal?: AbortSignal }): Promise<{ url: string; token: string }>;
  extendTimeout(durationMs: number, options?: { signal?: AbortSignal }): Promise<void>;
  listSessions(params?: { signal?: AbortSignal }): Promise<unknown>;
  stop(params?: { signal?: AbortSignal }): Promise<VercelStopResult>;
  delete(params?: { signal?: AbortSignal }): Promise<void>;
  writeFiles(files: VercelWriteFile[], options?: { signal?: AbortSignal }): Promise<void>;
  runCommand(params: VercelRunCommandRequest): Promise<VercelCommandResult>;
  domain(port: number): string;
}

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
  persistent: true;
  keepLastSnapshots: { count: 1 };
  tags: Record<string, string>;
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
  tags: Record<string, string>;
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
  // Throws unless the reference is fully qualified and digest-pinned.
  parseVercelImageReference(input.image);
  return {
    name: input.name,
    image: input.image,
    source: input.source,
    timeout: input.timeoutMs,
    ...(input.ports === undefined ? {} : { ports: [...input.ports] }),
    persistent: true,
    keepLastSnapshots: { count: 1 },
    tags: { ...input.tags },
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
  ): Promise<VercelCommandResult>;
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
      return call('Sandbox.getOrCreate', [credentials.token, sourcePassword], async () =>
        wrapSandboxHandle(await sandboxApi.getOrCreate(withFetch(params)), [credentials.token, sourcePassword]),
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
    runCommand: async (sandbox, params) => call(
      'Sandbox.runCommand',
      [],
      () => sandbox.runCommand(params),
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
        return (options?: { signal?: AbortSignal }) => callWithSecrets(
          'Sandbox.openInteractive',
          secrets,
          () => target.openInteractive(options),
        );
      }
      if (property === 'extendTimeout') {
        return (durationMs: number, options?: { signal?: AbortSignal }) => callWithSecrets(
          'Sandbox.extendTimeout',
          secrets,
          () => target.extendTimeout(durationMs, options),
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
