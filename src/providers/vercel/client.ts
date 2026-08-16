import { Sandbox, Snapshot } from '@vercel/sandbox';
import type { VercelCredentials } from './auth.js';
import { VERCEL_IMAGE_PIN } from './image.js';
import type { GitSource } from './source.js';
import { redactedError, redactSecrets } from './redaction.js';

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

export interface VercelCommandResult {
  exitCode: number;
  stdout?: (options?: { signal?: AbortSignal }) => Promise<string>;
  stderr?: (options?: { signal?: AbortSignal }) => Promise<string>;
}

export interface VercelSandboxHandle {
  readonly id?: string;
  readonly name: string;
  readonly status: SandboxSessionStatus;
  readonly persistent?: boolean;
  readonly image?: string;
  readonly timeout?: number;
  readonly tags?: Record<string, string>;
  readonly routes?: readonly SandboxRoute[];
  readonly keepLastSnapshots?: { count: number; expiration?: number; deleteEvicted?: boolean };
  readonly currentSnapshotId?: string;
  readonly activeCpuUsageMs?: number;
  readonly networkTransfer?: { ingress: number; egress: number };
  readonly totalActiveCpuDurationMs?: number;
  readonly totalIngressBytes?: number;
  readonly totalEgressBytes?: number;
  listSessions(params?: { signal?: AbortSignal }): Promise<unknown>;
  stop(params?: { signal?: AbortSignal }): Promise<VercelStopResult>;
  delete(params?: { signal?: AbortSignal }): Promise<void>;
  runCommand(
    command: string,
    args?: string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<VercelCommandResult>;
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

export interface VercelSandboxCreateInput {
  name: string;
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
  return {
    name: input.name,
    image: VERCEL_IMAGE_PIN.reference,
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
  runCommand(
    sandbox: VercelSandboxHandle,
    command: string,
    args?: string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
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
    this.notFound = status === 404 || status === 410;
  }
}

export function isVercelNotFound(error: unknown): boolean {
  return error instanceof VercelSdkError
    ? error.notFound
    : getStatus(error) === 404 || getStatus(error) === 410 || Boolean((error as { notFound?: unknown })?.notFound);
}

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
      throw new VercelSdkError(operation, error, secrets);
    }
  }

  return {
    getOrCreate: async (request) => {
      if (request.image !== VERCEL_IMAGE_PIN.reference) {
        throw new Error('Vercel Sandbox creation must use VERCEL_IMAGE_PIN.reference');
      }
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
    listSandboxes: async (request) => {
      const { credentials, ...listRequest } = request;
      return call('Sandbox.list', [credentials.token], async () => {
        const page = await sandboxApi.list(withFetch({
          ...listRequest,
          ...credentials,
          sortBy: 'name',
          sortOrder: 'asc',
          limit: 50,
        }));
        return collectPaginated<SandboxListRecord>(page, 'sandboxes');
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
    runCommand: async (sandbox, command, args, options) => call(
      'Sandbox.runCommand',
      [],
      () => sandbox.runCommand(command, args, options),
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
      if (property === 'runCommand') {
        return (
          command: string,
          args?: string[],
          options?: { signal?: AbortSignal; timeoutMs?: number },
        ) => callWithSecrets(
          'Sandbox.runCommand',
          secrets,
          () => target.runCommand(command, args, options),
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
    throw new VercelSdkError(operation, error, secrets);
  }
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

// Keep the redaction import exercised at the adapter boundary for errors that
// are constructed by callers before the SDK wraps them.
export function redactVercelError(error: unknown, token: string): Error {
  return redactedError(error, [token]);
}
