import { createInterface } from 'node:readline/promises';
import type { EventEmitter } from 'node:events';
import { RealShellRunner, type ShellRunner } from '../../lib/shell.js';
import {
  type DevboxProvider,
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
  type VercelRecoveryInput,
  type VercelStopReport,
} from './lifecycle.js';
import {
  createVercelBranchMetadataStore,
  createVercelScopeMetadataStore,
  type VercelBranchMetadata,
  type VercelBranchMetadataStore,
  type VercelScopeMetadata,
  type VercelScopeMetadataStore,
} from './metadata.js';
import { mapVercelError } from './errors.js';
import { createVercelBranchTag } from './identity.js';
import {
  normalizeRequestedSourceBranch,
  resolveGitHubSource,
  resolveVercelRepositoryCwd,
  resolveGitHubSourceOrigin,
  type GitHubSourcePlan,
  type GitHubSourceRemote,
} from './source.js';
import { recoverMissingBranchSandbox } from './recovery.js';
import {
  DisplayCredentialsNotFoundError,
  getDisplayCredentials as resolveDisplayCredentials,
} from './display-credentials.js';
import {
  createVercelTerminalAdapter,
  type VercelTerminalAdapter,
  type VercelTerminalFailure,
  type VercelTerminalResult,
  type VercelTerminalStreams,
} from './terminal.js';
import { prepareSandboxRuntime, RUNTIME_PREPARATION_TIMEOUT_MS } from './runtime.js';
import { addSecrets, redactSecrets } from './redaction.js';
import { DEVBOX_NOVNC_PROXY_PORT } from './ports.js';
import {
  applyAppPorts,
  type AppPortFlowMode,
  type AppPortFlowResult,
  type AppPortPrompt,
} from './app-port-flow.js';
import {
  renderVercelAttachNotice,
  renderVercelReadyBlock,
  renderVercelRoutes,
  resolveRouteLabels,
} from './provider-routes.js';

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
  /** Resolve the Sandbox image reference; defaults to release pin or channel. */
  resolveImage?: () => Promise<string>;
  lifecycle?: VercelLifecycleFactory | VercelLifecycle;
  lifecycleFactory?: VercelLifecycleFactory;
  terminal?: VercelTerminalAdapter;
  confirmation?: VercelConfirmation | VercelConfirmationBoundary | ScopeConfirmationBoundary;
  opener?: VercelOpener;
  stateHome?: string;
  client?: VercelSandboxClient;
  credentialOptions?: Omit<CredentialResolutionOptions, 'repoRoot' | 'env'>;
  signalSource?: EventEmitter;
  /** Injection seam for the public app-port confirmation prompt. */
  appPortPrompt?: AppPortPrompt;
}

interface PreparedOperation {
  lifecycle: VercelLifecycle;
  scopeStore: VercelScopeMetadataStore;
  branchStore?: VercelBranchMetadataStore;
  scopeMetadata: VercelScopeMetadata | null;
  metadata: VercelBranchMetadata | null;
  credentials: VercelCredentials;
  source?: GitHubSourcePlan;
  recovery?: VercelRecoveryInput;
  alreadyAbsent: boolean;
  /** Same-branch sandboxes in another Vercel scope, which are never touched. */
  foreignScope: string[];
}

interface PreparedUp {
  scopeStore: VercelScopeMetadataStore;
  branchStore: VercelBranchMetadataStore;
  metadata: VercelBranchMetadata | null;
  source: GitHubSourcePlan;
}

/** Create the production Vercel provider without doing auth or network work. */
export function createVercelProvider(options: VercelProviderOptions = {}): DevboxProvider {
  const runner = options.runner ?? new RealShellRunner();
  const terminal = options.terminal ?? createVercelTerminalAdapter();
  const client = options.client ?? createVercelSandboxClient();
  const makeLifecycle = options.lifecycleFactory
    ?? (typeof options.lifecycle === 'function' ? options.lifecycle : undefined)
    ?? ((lifecycleOptions: VercelLifecycleOptions) => createVercelLifecycle({
      ...lifecycleOptions,
      client,
      ...(options.resolveImage === undefined ? {} : { resolveImage: options.resolveImage }),
    }));
  const injectedLifecycle = options.lifecycle && typeof options.lifecycle !== 'function'
    ? options.lifecycle
    : undefined;
  const providerErrors = (
    request: ProviderRequestContext,
    action: string,
    operation: (secrets: string[]) => Promise<ProviderActionResult>,
  ) => withProviderErrors(
    request,
    action,
    operation,
    secretsFor(request.env, request.runtimeEnvironment),
  );

  const provider: DevboxProvider = {
    name: 'vercel',
    up: (request) => providerErrors(request, 'up', async (secrets) => {
      const prepared = await prepareUp(request, runner, options, secrets);
      let credentials!: VercelCredentials;
      await prepared.scopeStore.withLock(async () => {
        const scopeMetadata = await prepared.scopeStore.read();
        credentials = await resolveCredentials(
          request,
          options,
          scopeMetadata ? { teamId: scopeMetadata.teamId, projectId: scopeMetadata.projectId } : undefined,
        );
        addSecrets(secrets, credentials.token);
        const scope = { teamId: credentials.teamId, projectId: credentials.projectId };
        const renderedScope = renderScope(options.confirmation, scope);
        request.stderr.write(`${renderedScope}\n`);
        if (!scopeMetadata) {
          request.stderr.write(`${prepared.source.warning}\n`);
          await requireScopeConfirmation(scope, request, options.confirmation, renderedScope);
          await prepared.scopeStore.write(scope);
        }
      });
      const lifecycle = createLifecycle(
        request,
        options,
        runner,
        makeLifecycle,
        injectedLifecycle,
        credentials,
        prepared.source,
        prepared.branchStore,
        prepared.metadata,
      );
      const sandbox = await lifecycle.up();
      const runtimeOptions = {
        repoRoot: request.repoRoot,
        repository: prepared.source.remote.repository,
        env: request.env,
        ...(request.envPath === undefined ? {} : { envPath: request.envPath }),
        ...(request.runtimeEnvironment === undefined ? {} : { runtimeEnvironment: request.runtimeEnvironment }),
        shellRunner: runner,
        sandbox,
        client,
        stderr: request.stderr,
        hostHome: request.env.HOME,
        displayCredentialsStore: prepared.branchStore,
        secrets,
        signal: AbortSignal.timeout(RUNTIME_PREPARATION_TIMEOUT_MS),
      };
      const setupStatus = await prepareSandboxRuntime(runtimeOptions);
      request.runtimeEnvironment = runtimeOptions.runtimeEnvironment;
      const appPorts = await resolveAppPorts(
        request,
        options,
        client,
        sandbox,
        prepared.branchStore,
        prepared.source.remote.repository,
        secrets,
      );
      await renderVercelReadyBlock(
        request,
        sandbox,
        setupStatus,
        await displayToken(prepared.branchStore, secrets),
        appPorts,
      );
      return terminalResult(
        request,
        terminal,
        options.signalSource,
        sandbox,
        'up',
        prepared.source.remote.repository,
        secrets,
      );
    }),
    attach: (request) => providerErrors(request, 'attach', async (secrets) => {
      const prepared = await prepareStored(request, 'attach', runner, options, makeLifecycle, injectedLifecycle, client, secrets);
      const sandbox = await prepared.lifecycle.attach();
      const repository = prepared.source?.remote.repository;
      if (!repository) throw new VercelLifecycleError('metadata_incomplete', 'Stored Vercel source repository is unavailable');
      // Say this before anything that can prompt. Runtime sync and the app-port
      // question both come first, and a boot-shaped prompt with no preceding
      // context reads as "it is creating a new sandbox" -- which attach cannot
      // do: it fails when there is no record and no live box to resume.
      request.stderr.write(`Attaching to the existing Vercel sandbox for ${request.branch}\n`);
      const runtimeOptions = {
        repoRoot: request.repoRoot,
        repository,
        env: request.env,
        ...(request.envPath === undefined ? {} : { envPath: request.envPath }),
        ...(request.runtimeEnvironment === undefined ? {} : { runtimeEnvironment: request.runtimeEnvironment }),
        shellRunner: runner,
        sandbox,
        client,
        stderr: request.stderr,
        hostHome: request.env.HOME,
        displayCredentialsStore: prepared.branchStore!,
        secrets,
        signal: AbortSignal.timeout(RUNTIME_PREPARATION_TIMEOUT_MS),
      };
      const setupStatus = await prepareSandboxRuntime(runtimeOptions);
      request.runtimeEnvironment = runtimeOptions.runtimeEnvironment;
      const appPorts = await resolveAppPorts(
        request,
        options,
        client,
        sandbox,
        prepared.branchStore!,
        repository,
        secrets,
        'resume',
      );
      await renderVercelAttachNotice(
        request,
        sandbox,
        setupStatus,
        await displayToken(prepared.branchStore, secrets),
        appPorts,
      );
      return terminalResult(
        request,
        terminal,
        options.signalSource,
        sandbox,
        'attach',
        repository,
        secrets,
      );
    }),
    stop: (request) => providerErrors(request, 'stop', async (secrets) => {
      const prepared = await prepareStored(request, 'stop', runner, options, makeLifecycle, injectedLifecycle, client, secrets);
      const report = await prepared.lifecycle.stop();
      renderStopReport(request, report);
      return { exitCode: 0 };
    }),
    remove: (request) => providerErrors(request, 'remove', async (secrets) => {
      const prepared = await prepareStored(request, 'remove', runner, options, makeLifecycle, injectedLifecycle, client, secrets);
      if (prepared.alreadyAbsent) {
        try {
          await prepared.branchStore?.remove();
        } catch {
          // No live resource remains; local recovery state is best effort.
        }
        // Removal stays idempotent, but must not report a deletion it did not
        // perform: "cleanup verified" here is indistinguishable from having
        // actually removed a box, which hides a mistyped branch.
        //
        // Nor may it claim nothing exists while --list is showing one. A
        // same-branch box in another Vercel team/project is deliberately left
        // alone, but saying so is the difference between an honest no-op and a
        // command that appears broken.
        if (prepared.foreignScope.length > 0) {
          request.stderr.write(
            `No Vercel sandbox for ${request.branch} in this team/project.\n`
            + `  ${prepared.foreignScope.length} sandbox(es) for this branch belong to another Vercel `
            + 'team/project and were not touched:\n'
            + prepared.foreignScope.map((name) => `    ${name}\n`).join('')
            + '  set VERCEL_TEAM_ID/VERCEL_PROJECT_ID to that scope and retry to remove them\n',
          );
          return { exitCode: 0 };
        }
        request.stderr.write(
          `No Vercel sandbox exists for ${request.branch}; nothing to remove.\n`
          + '  run devbox --provider vercel --list to see existing boxes\n',
        );
        return { exitCode: 0 };
      }
      const result = await prepared.lifecycle.remove();
      if (!result.verified) {
        throw new VercelLifecycleError('cleanup_incomplete', 'Vercel cleanup verification did not converge');
      }
      request.stderr.write(`Vercel sandbox ${prepared.recovery?.identity.name ?? sandboxName(prepared.metadata, request.branch)}: cleanup verified\n`);
      return { exitCode: 0 };
    }),
    list: (request) => providerErrors(request, 'list', async (secrets) => {
      const prepared = await prepareStored(request, 'list', runner, options, makeLifecycle, injectedLifecycle, client, secrets);
      const records = await prepared.lifecycle.list();
      renderList(request, records);
      return { exitCode: 0 };
    }),
    url: (request) => providerErrors(request, 'url', async (secrets) => {
      const prepared = await prepareStored(request, 'url', runner, options, makeLifecycle, injectedLifecycle, client, secrets);
      const routes = await prepared.lifecycle.routes();
      if (routes.length === 0) {
        throw new VercelLifecycleError('route_not_found', 'Vercel Sandbox has no routes');
      }
      const labels = await resolveRouteLabels(request.repoRoot);
      const token = await displayToken(prepared.branchStore, secrets);
      const renderedRoutes = renderVercelRoutes(routes, labels, token);
      for (const rendered of renderedRoutes) request.stdout.write(`${rendered.line}\n`);
      if (request.open) {
        const noVnc = renderedRoutes.find(({ route }) => route.port === DEVBOX_NOVNC_PROXY_PORT);
        if (!noVnc) {
          throw new VercelLifecycleError(
            'route_not_found',
            `Vercel Sandbox has no authenticated noVNC route for port ${DEVBOX_NOVNC_PROXY_PORT}`,
          );
        }
        await (options.opener ?? defaultOpener(runner))(noVnc.url);
      }
      return { exitCode: 0 };
    }),
    getDisplayCredentials: async (request) => {
      const secrets = secretsFor(request.env);
      try {
        const origin = await resolveGitHubSourceOrigin({
          repoRoot: request.repoRoot,
          env: request.env,
          shellRunner: runner,
        });
        const branchStore = createBranchStore(
          origin,
          normalizeRequestedSourceBranch(request.branch),
          options,
        );
        const resolution = await resolveDisplayCredentials(branchStore);
        addSecrets(secrets, resolution.credentials.password);
        return {
          supported: true,
          username: resolution.credentials.username,
          password: resolution.credentials.password,
        };
      } catch (error) {
        throw mapVercelError(error, {
          action: 'password',
          branch: request.branch,
          secrets,
        });
      }
    },
  };

  return provider;
}

async function prepareUp(
  request: ProviderBranchRequest,
  runner: ShellRunner,
  options: VercelProviderOptions,
  secrets: string[],
): Promise<PreparedUp> {
  const source = await resolveGitHubSource({
    repoRoot: request.repoRoot,
    branch: request.branch,
    env: request.env,
    shellRunner: runner,
  });
  addSecrets(secrets, source.source.password);
  const scopeStore = createScopeStore(source.remote, options);
  const branchStore = createBranchStore(source.remote, source.requestedBranch, options);
  const metadata = await branchStore.read();
  addSecrets(secrets, metadata?.displayCredentials?.password);
  return { scopeStore, branchStore, metadata, source };
}

async function prepareStored(
  request: ProviderBranchRequest | ProviderListRequest,
  action: string,
  runner: ShellRunner,
  options: VercelProviderOptions,
  makeLifecycle: VercelLifecycleFactory,
  injectedLifecycle: VercelLifecycle | undefined,
  client: VercelSandboxClient,
  secrets: string[],
): Promise<PreparedOperation> {
  const origin = await resolveGitHubSourceOrigin({
    repoRoot: request.repoRoot,
    env: request.env,
    shellRunner: runner,
  });
  const scopeStore = createScopeStore(origin, options);
  const scopeMetadata = await scopeStore.read();
  const storedScope = scopeMetadata
    ? { teamId: scopeMetadata.teamId, projectId: scopeMetadata.projectId }
    : undefined;
  const credentials = await resolveCredentials(request, options, storedScope);
  addSecrets(secrets, credentials.token);
  if (action === 'list') {
    const lifecycle = createLifecycle(
      request,
      options,
      runner,
      makeLifecycle,
      injectedLifecycle,
      credentials,
      undefined,
      undefined,
      null,
      true,
      origin.canonical,
    );
    return {
      lifecycle,
      scopeStore,
      scopeMetadata,
      metadata: null,
      credentials,
      source: undefined,
      alreadyAbsent: false,
      foreignScope: [],
    };
  }
  const branch = normalizeRequestedSourceBranch((request as ProviderBranchRequest).branch);
  const branchStore = createBranchStore(origin, branch, options);
  let metadata: VercelBranchMetadata | null;
  try {
    metadata = await branchStore.read();
  } catch (error) {
    if (action !== 'remove') throw error;
    metadata = null;
  }
  addSecrets(secrets, metadata?.displayCredentials?.password);
  const source = storedSource(origin, branch, metadata, action === 'remove', action === 'remove');
  if (!metadata && action !== 'remove') {
    throw new VercelLifecycleError(
      'resource_not_found',
      `Vercel metadata record was not found for ${origin.canonical} branch ${branch}`,
    );
  }
  let recovery: VercelRecoveryInput | undefined;
  let alreadyAbsent = false;
  let foreignScope: string[] = [];
  if (action === 'remove' && !metadata) {
    const result = await recoverMissingBranchSandbox(client, origin, branch, credentials);
    foreignScope = result.foreignScope;
    if (!result.recovered) {
      alreadyAbsent = true;
    } else {
      recovery = {
        identity: result.recovered.identity,
        ...(result.recovered.snapshotIds === undefined ? {} : { snapshotIds: result.recovered.snapshotIds }),
      };
    }
  }
  const lifecycle = createLifecycle(
    request,
    options,
    runner,
    makeLifecycle,
    injectedLifecycle,
    credentials,
    source,
    branchStore,
    metadata,
    false,
    origin.canonical,
    recovery,
  );
  return {
    lifecycle,
    scopeStore,
    branchStore,
    scopeMetadata,
    metadata,
    credentials,
    source,
    recovery,
    alreadyAbsent,
    foreignScope,
  };
}

function createScopeStore(
  remote: GitHubSourceRemote,
  options: VercelProviderOptions,
): VercelScopeMetadataStore {
  return createVercelScopeMetadataStore({
    repoKey: remote.canonical,
    ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
  });
}

function createBranchStore(
  remote: GitHubSourceRemote,
  branch: string,
  options: VercelProviderOptions,
): VercelBranchMetadataStore {
  return createVercelBranchMetadataStore({
    repoKey: remote.canonical,
    branch,
    ...(options.stateHome === undefined ? {} : { stateHome: options.stateHome }),
  });
}

function renderScope(
  confirmation: VercelProviderOptions['confirmation'],
  scope: VercelScope,
): string {
  return typeof confirmation === 'object' && confirmation?.render
    ? confirmation.render(scope)
    : renderVercelScope(scope);
}

function createLifecycle(
  request: ProviderBranchRequest | ProviderListRequest,
  options: VercelProviderOptions,
  runner: ShellRunner,
  makeLifecycle: VercelLifecycleFactory,
  injectedLifecycle: VercelLifecycle | undefined,
  credentials: VercelCredentials,
  source: GitHubSourcePlan | undefined,
  branchStore: VercelBranchMetadataStore | undefined,
  metadata: VercelBranchMetadata | null,
  listOnly = false,
  repository?: string,
  recovery?: VercelRecoveryInput,
): VercelLifecycle {
  const repoKey = source?.remote.canonical ?? repository;
  if (!repoKey) throw new Error('Vercel lifecycle repository is required');
  return injectedLifecycle ?? makeLifecycle({
    repoRoot: request.repoRoot,
    ...(source?.requestedBranch === undefined ? {} : { branch: source.requestedBranch }),
    env: request.env,
    ...(request.runtimeEnvironment === undefined ? {} : { runtimeEnvironment: request.runtimeEnvironment }),
    credentials,
    ...(source === undefined ? {} : { source }),
    shellRunner: runner,
    ...(listOnly ? {} : { branchMetadataStore: branchStore }),
    listOnly,
    stateHome: options.stateHome,
    repoKey,
    repository: repoKey,
    ...(recovery === undefined ? {} : { recovery }),
    ...(metadata?.configuration === undefined ? {} : { timeoutMs: metadata.configuration.timeoutMs }),
    ...(options.credentialOptions === undefined ? {} : { credentialOptions: options.credentialOptions }),
  });
}

function storedSource(
  origin: GitHubSourceRemote,
  branch: string,
  metadata: VercelBranchMetadata | null,
  allowMissing: boolean,
  allowIncomplete: boolean,
): GitHubSourcePlan {
  if (!metadata) {
    if (!allowMissing) {
      throw new VercelLifecycleError(
        'resource_not_found',
        `Vercel metadata record was not found for ${origin.canonical}`,
      );
    }
    const requestedBranch = normalizeRequestedSourceBranch(branch);
    return sourceWithoutCredentials(origin, requestedBranch, requestedBranch, false);
  }
  if (!metadata.identity || (!metadata.configuration && !allowIncomplete)) {
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
  if (!configuration) {
    return sourceWithoutCredentials(origin, requestedBranch, requestedBranch, false);
  }
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
      onDeviceAuthorization: options.credentialOptions?.onDeviceAuthorization
        ?? createDeviceAuthorizationHandler(request, options),
    });
  }
  return resolveVercelCredentials({
    repoRoot: request.repoRoot,
    env: request.env,
    ...(options.credentialOptions ?? {}),
    onDeviceAuthorization: options.credentialOptions?.onDeviceAuthorization
      ?? createDeviceAuthorizationHandler(request, options),
  });
}

function createDeviceAuthorizationHandler(
  request: ProviderRequestContext,
  options: VercelProviderOptions,
): NonNullable<CredentialResolutionOptions['onDeviceAuthorization']> {
  return async (authorization) => {
    const completeUrl = typeof authorization.verification_uri_complete === 'string'
      ? authorization.verification_uri_complete.trim()
      : '';
    const verificationUrl = typeof authorization.verification_uri === 'string'
      ? authorization.verification_uri.trim()
      : '';
    const userCode = typeof authorization.user_code === 'string' ? authorization.user_code.trim() : '';
    const displayUrl = completeUrl || verificationUrl;
    if (!displayUrl || !userCode) {
      throw new Error('Vercel device authorization returned incomplete verification details');
    }
    request.stderr.write(`Vercel device authorization URL: ${displayUrl}\n`);
    if (verificationUrl && verificationUrl !== displayUrl) {
      request.stderr.write(`Vercel device authorization base URL: ${verificationUrl}\n`);
    }
    request.stderr.write(`Vercel device authorization code: ${userCode}\n`);
    if (options.opener) await options.opener(displayUrl);
  };
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
  action: 'up' | 'attach',
  repository: string,
  secrets: readonly string[],
): Promise<ProviderActionResult> {
  const cwd = resolveVercelRepositoryCwd(sandbox.cwd, repository);
  const streams: VercelTerminalStreams = {
    stdin: request.stdin,
    stdout: request.stdout,
    stderr: request.stderr,
  };
  const failures: VercelTerminalFailure[] = [];
  const terminalOptions = {
    cwd,
    tty: request.tty,
    streams,
    onError: (failure: VercelTerminalFailure) => {
      failures.push(failure);
      return true;
    },
    getSize: () => ({
      cols: request.stdout.columns ?? 80,
      rows: request.stdout.rows ?? 24,
    }),
    ...(request.runtimeEnvironment === undefined ? {} : { env: request.runtimeEnvironment }),
    ...(signalSource === undefined ? {} : { signalSource }),
  };
  const result = await terminal.attach(sandbox, terminalOptions);
  if (result.status === 'detached' && result.reason === 'error') {
    const failure = result.error ?? failures.at(-1);
    throw mapVercelError(failure?.cause ?? new Error('Vercel terminal transport failed'), {
      action,
      branch: request.branch,
      secrets,
    });
  }
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
    const branchTag = record.tags?.branch;
    const branch = branchFromTag(branchTag) ?? branchTag ?? 'unknown';
    request.stderr.write(`  ${record.name} ${record.status} branch=${branch} identity=${identity}\n`);
  }
  // Rows are not marked with the scope that owns them. The identity tag hashes
  // the team and project, and recomputing it needs the exact branch string --
  // which the branch tag cannot yield back for any branch containing a slash
  // (`feature/ui` sanitizes to `feature-ui` but hashes the original). A marker
  // that silently never fires for the commonest branch shape would read as
  // "every row is yours", so the listing stays neutral and `--rm` explains the
  // scope it declined to touch. Distinguishing them here needs a scope tag on
  // the sandbox itself.
}

/**
 * Detect, confirm, and apply public app routes for the remote checkout.
 *
 * The Sandbox is already usable at this point, so a detector or route-update
 * failure is reported and the box still comes up with noVNC and the explicit
 * configured ports.
 */
async function resolveAppPorts(
  request: ProviderBranchRequest,
  options: VercelProviderOptions,
  client: VercelSandboxClient,
  sandbox: VercelSandboxHandle,
  branchStore: VercelBranchMetadataStore,
  repository: string,
  secrets: readonly string[],
  mode: AppPortFlowMode = 'boot',
): Promise<AppPortFlowResult | undefined> {
  try {
    return await applyAppPorts({
      mode,
      sandbox,
      client,
      branchStore,
      repoRoot: request.repoRoot,
      workspace: resolveVercelRepositoryCwd(sandbox.cwd, repository),
      branch: request.branch,
      tty: request.tty,
      stdin: request.stdin,
      stderr: request.stderr,
      ...(request.exposePorts === undefined ? {} : { exposePorts: request.exposePorts }),
      secrets,
      ...(options.appPortPrompt === undefined ? {} : { prompt: options.appPortPrompt }),
    });
  } catch (error) {
    request.stderr.write(
      `app ports: ${redactSecrets(error, secrets)}; continuing with configured routes only\n`,
    );
    return undefined;
  }
}

async function displayToken(
  store: VercelBranchMetadataStore | undefined,
  secrets: string[],
): Promise<string> {
  if (!store) throw new DisplayCredentialsNotFoundError();
  const token = (await resolveDisplayCredentials(store)).credentials.password;
  addSecrets(secrets, token);
  return token;
}

/**
 * Recover the branch a listed Sandbox belongs to.
 *
 * The branch tag is `sanitize(branch)-<hash>`, which is not reversible in
 * general -- `feat/foo` sanitizes to `feat-foo`. Strip the hash and keep the
 * result only when it rebuilds the identical tag, so the value printed is
 * always one the user can actually pass back to devbox. Otherwise the raw tag
 * is shown rather than a branch that would silently fail to match.
 */
function branchFromTag(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const candidate = tag.replace(/-[a-f0-9]{16}$/, '');
  if (candidate === tag) return undefined;
  return createVercelBranchTag(candidate) === tag ? candidate : undefined;
}

function sandboxName(metadata: VercelBranchMetadata | null, branch: string): string {
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
  operation: (secrets: string[]) => Promise<ProviderActionResult>,
  secrets: string[],
): Promise<ProviderActionResult> {
  try {
    return await operation(secrets);
  } catch (error) {
    const branch = (request as ProviderRequestContext & { branch?: unknown }).branch;
    throw mapVercelError(error, {
      action,
      branch: typeof branch === 'string' ? branch : undefined,
      secrets,
    });
  }
}

function secretsFor(
  env: Record<string, string | undefined>,
  runtimeEnvironment?: Record<string, string>,
): string[] {
  return [
    env.GH_TOKEN,
    env.GITHUB_TOKEN,
    env.VERCEL_TOKEN,
    env.VERCEL_OIDC_TOKEN,
    ...(runtimeEnvironment === undefined
      ? []
      : Object.values(runtimeEnvironment).filter((value) => value.length >= 8)),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Exposed for provider-focused tests without coupling them to terminal internals. */
export const mapVercelTerminalResult = mapTerminalResult;
export const createVercelProviderConfirmation = requireScopeConfirmation;
