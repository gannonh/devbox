import { createInterface } from 'node:readline/promises';
import type { EventEmitter } from 'node:events';
import { RealShellRunner, type ShellRunner } from '../../lib/shell.js';
import {
  type DevboxProvider,
  type DisplayCredentialsResult,
  type ProviderActionResult,
  type ProviderBranchRequest,
  type ProviderListRequest,
  type ProviderRequestContext,
} from '../types.js';
import {
  renderVercelScope,
  resolveVercelCredentials,
  resolveVercelCredentialsForScope,
  type CredentialResolutionOptions,
  type ScopeConfirmationBoundary,
  type VercelCredentials,
  type VercelScope,
} from './auth.js';
import {
  createVercelSandboxClient,
  type VercelSandboxClient,
  type VercelSandboxHandle,
} from './client.js';
import {
  VercelLifecycleError,
  createVercelLifecycle,
  type VercelLifecycle,
  type VercelLifecycleOptions,
  type VercelStopReport,
} from './lifecycle.js';
import {
  createVercelMetadataStore,
  type VercelMetadata,
  type VercelMetadataStore,
} from './metadata.js';
import { mapVercelError } from './errors.js';
import {
  normalizeRequestedSourceBranch,
  resolveGitHubSource,
  resolveGitHubSourceOrigin,
  type GitHubSourcePlan,
  type GitHubSourceRemote,
} from './source.js';
import {
  createVercelTerminalAdapter,
  type VercelTerminalAdapter,
  type VercelTerminalResult,
  type VercelTerminalStreams,
} from './terminal.js';

export type VercelLifecycleFactory = (options: VercelLifecycleOptions) => VercelLifecycle;
export type VercelConfirmation = (
  scope: VercelScope,
  request: ProviderRequestContext,
) => boolean | Promise<boolean>;
export interface VercelConfirmationBoundary {
  render?: (scope: VercelScope) => string;
  confirm: (message: string, scope: VercelScope) => boolean | Promise<boolean>;
}
export type VercelOpener = (url: string) => void | Promise<void>;

export interface VercelProviderOptions {
  runner?: ShellRunner;
  lifecycle?: VercelLifecycleFactory | VercelLifecycle;
  lifecycleFactory?: VercelLifecycleFactory;
  terminal?: VercelTerminalAdapter;
  confirmation?: VercelConfirmation | VercelConfirmationBoundary | ScopeConfirmationBoundary;
  opener?: VercelOpener;
  stateHome?: string;
  client?: VercelSandboxClient;
  credentialOptions?: Omit<CredentialResolutionOptions, 'repoRoot' | 'env'>;
  signalSource?: EventEmitter;
}

interface PreparedOperation {
  lifecycle: VercelLifecycle;
  metadataStore: VercelMetadataStore;
  metadata: VercelMetadata | null;
  credentials: VercelCredentials;
  source: GitHubSourcePlan;
}

/** Create the production Vercel provider without doing auth or network work. */
export function createVercelProvider(options: VercelProviderOptions = {}): DevboxProvider {
  const runner = options.runner ?? new RealShellRunner();
  const terminal = options.terminal ?? createVercelTerminalAdapter();
  const makeLifecycle = options.lifecycleFactory
    ?? (typeof options.lifecycle === 'function' ? options.lifecycle : undefined)
    ?? ((lifecycleOptions: VercelLifecycleOptions) => {
      const client = options.client ?? createVercelSandboxClient();
      return createVercelLifecycle({ ...lifecycleOptions, client });
    });
  const injectedLifecycle = options.lifecycle && typeof options.lifecycle !== 'function'
    ? options.lifecycle
    : undefined;

  const provider: DevboxProvider = {
    name: 'vercel',
    up: (request) => withProviderErrors(request, 'up', async () => {
      const prepared = await prepareUp(request, runner, options, makeLifecycle, injectedLifecycle);
      const sandbox = await prepared.lifecycle.up();
      return terminalResult(request, terminal, options.signalSource, sandbox);
    }),
    attach: (request) => withProviderErrors(request, 'attach', async () => {
      const prepared = await prepareStored(request, 'attach', runner, options, makeLifecycle, injectedLifecycle);
      const sandbox = await prepared.lifecycle.attach();
      return terminalResult(request, terminal, options.signalSource, sandbox);
    }),
    stop: (request) => withProviderErrors(request, 'stop', async () => {
      const prepared = await prepareStored(request, 'stop', runner, options, makeLifecycle, injectedLifecycle);
      const report = await prepared.lifecycle.stop();
      renderStopReport(request, report);
      return { exitCode: 0 };
    }),
    remove: (request) => withProviderErrors(request, 'remove', async () => {
      const prepared = await prepareStored(request, 'remove', runner, options, makeLifecycle, injectedLifecycle);
      const result = await prepared.lifecycle.remove();
      if (!result.verified) {
        throw new VercelLifecycleError('cleanup_incomplete', 'Vercel cleanup verification did not converge');
      }
      request.stderr.write(`Vercel sandbox ${sandboxName(prepared.metadata, request.branch)}: cleanup verified\n`);
      return { exitCode: 0 };
    }),
    list: (request) => withProviderErrors(request, 'list', async () => {
      const prepared = await prepareStored(request, 'list', runner, options, makeLifecycle, injectedLifecycle);
      const records = await prepared.lifecycle.list();
      renderList(request, records);
      return { exitCode: 0 };
    }),
    url: (request) => withProviderErrors(request, 'url', async () => {
      const prepared = await prepareStored(request, 'url', runner, options, makeLifecycle, injectedLifecycle);
      const routes = await prepared.lifecycle.routes();
      if (routes.length === 0) {
        throw new VercelLifecycleError('route_not_found', 'Vercel Sandbox has no routes');
      }
      for (const route of routes) request.stdout.write(`${route.port}: ${route.url}\n`);
      if (request.open) await (options.opener ?? defaultOpener(runner))(routes[0].url);
      return { exitCode: 0 };
    }),
    getDisplayCredentials: async (): Promise<DisplayCredentialsResult> => ({
      supported: false,
      message: 'display credentials are not supported by the Vercel provider in the core phase; use --url for current routes',
    }),
  };

  return provider;
}

async function prepareUp(
  request: ProviderBranchRequest,
  runner: ShellRunner,
  options: VercelProviderOptions,
  makeLifecycle: VercelLifecycleFactory,
  injectedLifecycle: VercelLifecycle | undefined,
): Promise<PreparedOperation> {
  const source = await resolveGitHubSource({
    repoRoot: request.repoRoot,
    branch: request.branch,
    env: request.env,
    shellRunner: runner,
  });
  const metadataStore = createMetadataStore(source.remote, options);
  const metadata = await metadataStore.read();
  const credentials = await resolveCredentials(request, options, metadata?.teamId && metadata.projectId
    ? { teamId: metadata.teamId, projectId: metadata.projectId }
    : undefined);
  const scope = { teamId: credentials.teamId, projectId: credentials.projectId };

  const renderedScope = typeof options.confirmation === 'object' && options.confirmation?.render
    ? options.confirmation.render(scope)
    : renderVercelScope(scope);
  request.stderr.write(`${renderedScope}\n`);
  if (!metadata) {
    request.stderr.write(`${source.warning}\n`);
    await requireScopeConfirmation(scope, request, options.confirmation, renderedScope);
  }

  const lifecycle = injectedLifecycle ?? makeLifecycle({
    repoRoot: request.repoRoot,
    branch: request.branch,
    env: request.env,
    credentials,
    source,
    shellRunner: runner,
    metadataStore,
    stateHome: options.stateHome,
    repoKey: source.remote.canonical,
    ...(metadata?.configuration === undefined ? {} : { timeoutMs: metadata.configuration.timeoutMs }),
    ...(options.credentialOptions === undefined ? {} : { credentialOptions: options.credentialOptions }),
  });
  return { lifecycle, metadataStore, metadata, credentials, source };
}

async function prepareStored(
  request: ProviderBranchRequest | ProviderListRequest,
  action: string,
  runner: ShellRunner,
  options: VercelProviderOptions,
  makeLifecycle: VercelLifecycleFactory,
  injectedLifecycle: VercelLifecycle | undefined,
): Promise<PreparedOperation> {
  const origin = await resolveGitHubSourceOrigin({
    repoRoot: request.repoRoot,
    env: request.env,
    shellRunner: runner,
  });
  const metadataStore = createMetadataStore(origin, options);
  const metadata = await metadataStore.read();
  const branch = 'branch' in request ? request.branch : metadata?.identity?.branch ?? 'main';
  const source = storedSource(origin, branch, metadata, action === 'list');
  const storedScope = metadata && metadata.teamId && metadata.projectId
    ? { teamId: metadata.teamId, projectId: metadata.projectId }
    : undefined;
  const credentials = await resolveCredentials(request, options, storedScope);
  const lifecycle = injectedLifecycle ?? makeLifecycle({
    repoRoot: request.repoRoot,
    branch,
    env: request.env,
    credentials,
    source,
    shellRunner: runner,
    metadataStore,
    stateHome: options.stateHome,
    repoKey: origin.canonical,
    ...(metadata?.configuration === undefined ? {} : { timeoutMs: metadata.configuration.timeoutMs }),
    ...(options.credentialOptions === undefined ? {} : { credentialOptions: options.credentialOptions }),
  });
  return { lifecycle, metadataStore, metadata, credentials, source };
}

function createMetadataStore(remote: GitHubSourceRemote, options: VercelProviderOptions): VercelMetadataStore {
  return createVercelMetadataStore({
    repoKey: remote.canonical,
    ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
  });
}

function storedSource(
  origin: GitHubSourceRemote,
  branch: string,
  metadata: VercelMetadata | null,
  allowMissing: boolean,
): GitHubSourcePlan {
  if (!metadata) {
    if (!allowMissing) {
      throw new VercelLifecycleError(
        'resource_not_found',
        `Vercel metadata record was not found for ${origin.canonical}`,
      );
    }
    return sourceWithoutCredentials(origin, 'main', 'main', false);
  }
  if (!metadata.identity || !metadata.configuration) {
    throw new VercelLifecycleError('metadata_incomplete', 'Vercel metadata does not contain stored source configuration');
  }
  const requestedBranch = normalizeRequestedSourceBranch(branch);
  if (metadata.identity.repository !== origin.canonical || metadata.identity.branch !== requestedBranch) {
    throw new VercelLifecycleError(
      'identity_conflict',
      'Stored Vercel Sandbox identity does not match this repository and branch',
    );
  }
  const configuration = metadata.configuration;
  if (configuration.requestedBranch !== metadata.identity.branch) {
    throw new VercelLifecycleError('metadata_incomplete', 'Vercel metadata branch configuration is inconsistent');
  }
  return sourceWithoutCredentials(
    origin,
    configuration.requestedBranch,
    configuration.sourceRevision,
    configuration.needsBranchSetup,
    configuration.sourceUrl,
  );
}

function sourceWithoutCredentials(
  remote: GitHubSourceRemote,
  requestedBranch: string,
  revision: string,
  needsBranchSetup: boolean,
  sourceUrl = remote.url,
): GitHubSourcePlan {
  return {
    remote,
    defaultBranch: revision,
    requestedBranch,
    requestedBranchExists: !needsBranchSetup,
    needsBranchSetup,
    source: {
      type: 'git',
      url: sourceUrl,
      revision,
      username: 'x-access-token',
      password: '',
    },
    warning: '',
  };
}

async function resolveCredentials(
  request: ProviderRequestContext,
  options: VercelProviderOptions,
  storedScope?: VercelScope,
): Promise<VercelCredentials> {
  if (storedScope) {
    return resolveVercelCredentialsForScope({
      repoRoot: request.repoRoot,
      env: request.env,
      scope: storedScope,
      ...(options.credentialOptions ?? {}),
    });
  }
  return resolveVercelCredentials({
    repoRoot: request.repoRoot,
    env: request.env,
    ...(options.credentialOptions ?? {}),
  });
}

async function requireScopeConfirmation(
  scope: VercelScope,
  request: ProviderRequestContext,
  confirmation: VercelProviderOptions['confirmation'],
  renderedScope?: string,
): Promise<void> {
  if (!request.tty) throw new Error('Vercel scope confirmation requires a TTY');
  if (!confirmation) {
    const interfaceHandle = createInterface({ input: request.stdin, output: request.stderr });
    try {
      const answer = await interfaceHandle.question('Create this Vercel sandbox? [y/N] ');
      if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('Vercel scope confirmation was refused');
    } finally {
      interfaceHandle.close();
    }
    return;
  }
  if (typeof confirmation === 'function') {
    if (!(await confirmation(scope, request))) throw new Error('Vercel scope confirmation was refused');
    return;
  }
  const message = renderedScope ?? confirmation.render?.(scope) ?? renderVercelScope(scope);
  if (!(await confirmation.confirm(message, scope))) {
    throw new Error('Vercel scope confirmation was refused');
  }
}

async function terminalResult(
  request: ProviderBranchRequest,
  terminal: VercelTerminalAdapter,
  signalSource: EventEmitter | undefined,
  sandbox: VercelSandboxHandle,
): Promise<ProviderActionResult> {
  const cwd = sandbox.cwd?.trim() || '/vercel/sandbox';
  const streams: VercelTerminalStreams = {
    stdin: request.stdin,
    stdout: request.stdout,
    stderr: request.stderr,
  };
  const terminalOptions = {
    cwd,
    tty: request.tty,
    streams,
    getSize: () => ({
      cols: request.stdout.columns ?? 80,
      rows: request.stdout.rows ?? 24,
    }),
    ...(signalSource === undefined ? {} : { signalSource }),
  };
  const result = await terminal.attach(sandbox, terminalOptions);
  return mapTerminalResult(result);
}

function mapTerminalResult(result: VercelTerminalResult): ProviderActionResult {
  if (result.status === 'exited') return { exitCode: result.code };
  return { exitCode: result.reason === 'error' ? 1 : 0 };
}

function renderStopReport(request: ProviderBranchRequest, report: VercelStopReport): void {
  const status = report.finalSession?.status ?? 'stopped';
  request.stderr.write(`Vercel sandbox ${report.name}: ${status}\n`);
  if (report.snapshot) request.stderr.write(`snapshot: ${report.snapshot.id} ${report.snapshot.status}\n`);
  if (report.activeCpuUsageMs !== undefined) request.stderr.write(`cpu: ${report.activeCpuUsageMs}ms\n`);
  if (report.networkTransfer) {
    request.stderr.write(`network: ingress=${report.networkTransfer.ingress} egress=${report.networkTransfer.egress}\n`);
  }
}

function renderList(
  request: ProviderListRequest,
  records: ReadonlyArray<{ name: string; status: string; tags?: Record<string, string> }>,
): void {
  request.stderr.write('Vercel sandboxes for current repository:\n');
  if (records.length === 0) {
    request.stderr.write('  (none)\n');
    return;
  }
  for (const record of records) {
    const identity = record.tags?.identity ?? 'unknown';
    const branch = record.tags?.branch ?? 'unknown';
    request.stderr.write(`  ${record.name} ${record.status} branch=${branch} identity=${identity}\n`);
  }
}

function sandboxName(metadata: VercelMetadata | null, branch: string): string {
  return metadata?.identity?.name ?? `for ${branch}`;
}

function defaultOpener(runner: ShellRunner): VercelOpener {
  return async (url) => {
    const result = await runner.execQuiet('open', [url], {});
    if (result.code !== 0) throw new Error(`could not open browser for ${url}`);
  };
}

async function withProviderErrors(
  request: ProviderRequestContext,
  action: string,
  operation: () => Promise<ProviderActionResult>,
): Promise<ProviderActionResult> {
  try {
    return await operation();
  } catch (error) {
    const branch = (request as ProviderRequestContext & { branch?: unknown }).branch;
    throw mapVercelError(error, {
      action,
      branch: typeof branch === 'string' ? branch : undefined,
      secrets: secretsFor(request.env),
    });
  }
}

function secretsFor(env: Record<string, string | undefined>): string[] {
  return [
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.VERCEL_TOKEN,
    env.VERCEL_OIDC_TOKEN,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Exposed for provider-focused tests without coupling them to terminal internals. */
export const mapVercelTerminalResult = mapTerminalResult;
export const createVercelProviderConfirmation = requireScopeConfirmation;
