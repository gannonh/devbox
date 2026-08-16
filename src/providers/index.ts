export {
  createProviderRegistry,
  defaultProviderRegistry,
  getProvider,
  resolveProvider,
} from './registry.js';
export { createLocalProvider } from './local/provider.js';
export {
  createVercelProvider,
  createVercelProviderConfirmation,
  mapVercelTerminalResult,
} from './vercel/provider.js';
export type {
  VercelConfirmation,
  VercelConfirmationBoundary,
  VercelLifecycleFactory,
  VercelOpener,
  VercelProviderOptions,
} from './vercel/provider.js';
export {
  confirmVercelScope,
  renderVercelScope,
  resolveVercelCredentials,
  resolveVercelCredentialsForScope,
} from './vercel/auth.js';
export type {
  CredentialResolutionOptions,
  DeviceAuthContext,
  DeviceAuthPrimitives,
  DeviceAuthResult,
  ScopeConfirmationBoundary,
  StoredScopeCredentialResolutionOptions,
  VercelCredentials,
  VercelScope,
} from './vercel/auth.js';
export {
  mapVercelError,
  VercelProviderError,
} from './vercel/errors.js';
export type {
  VercelErrorContext,
  VercelProviderErrorCode,
} from './vercel/errors.js';
export {
  createVercelBranchMetadataStore,
  createVercelMetadataStore,
  createVercelScopeMetadataStore,
} from './vercel/metadata.js';
export type {
  MetadataLock,
  MetadataLockOptions,
  VercelBranchMetadata,
  VercelBranchMetadataInput,
  VercelBranchMetadataStore,
  VercelCreateConfiguration,
  VercelIdentityTags,
  VercelMetadata,
  VercelMetadataIdentity,
  VercelMetadataInput,
  VercelMetadataStore,
  VercelMetadataStoreOptions,
  VercelResidualMetadata,
  VercelScopeMetadata,
  VercelScopeMetadataInput,
  VercelScopeMetadataStore,
} from './vercel/metadata.js';
export {
  createVercelIdentity,
  normalizeGitHubRemote,
  normalizeBranch,
  sanitizeVercelName,
} from './vercel/identity.js';
export type {
  GitHubRemoteIdentity,
  VercelIdentityInput,
  VercelSandboxIdentity,
} from './vercel/identity.js';
export {
  cleanupVercelSandbox,
  STOPPABLE_SESSION_STATES,
  TERMINAL_SESSION_STATES,
} from './vercel/cleanup.js';
export type {
  VercelCleanupAdapter,
  VercelCleanupOptions,
  VercelCleanupResult,
} from './vercel/cleanup.js';
export {
  buildVercelSandboxCreateRequest,
  createVercelSandboxClient,
  isVercelNotFound,
  isVercelStale,
  VercelSdkError,
} from './vercel/client.js';
export type {
  SandboxListRecord,
  SandboxRoute,
  SandboxSessionRecord,
  SandboxSessionStatus,
  SandboxSnapshotRecord,
  SandboxSnapshotStatus,
  VercelCommandResult,
  VercelSandboxDeleteByNameRequest,
  VercelSandboxDeleteByNameResult,
  VercelSandboxApi,
  VercelSandboxClient,
  VercelSandboxCreateRequest,
  VercelSandboxHandle,
  VercelSnapshotApi,
  VercelSnapshotHandle,
  VercelStopResult,
} from './vercel/client.js';
export {
  createVercelLifecycle,
  DEFAULT_VERCEL_SANDBOX_TIMEOUT_MS,
  VercelCleanupError,
  VercelIdentityConflictError,
  VercelLifecycleError,
  VercelResourceNotFoundError,
  VercelRouteNotFoundError,
  VercelScopeConflictError,
} from './vercel/lifecycle.js';
export type {
  VercelLifecycle,
  VercelLifecycleOptions,
  VercelStopReport,
} from './vercel/lifecycle.js';
export {
  REDACTED_SECRET,
  redactSecrets,
  redactedError,
} from './vercel/redaction.js';
export {
  normalizeGitHubSourceRemote,
  normalizeRequestedSourceBranch,
  parseRemoteDefaultBranch,
  remoteBranchOutputContains,
  renderRemoteSourceNotice,
  resolveGitHubSource,
  resolveGitHubSourceOrigin,
  resolveGitHubToken,
  selectGitHubRevision,
} from './vercel/source.js';
export type {
  GitHubRevisionSelection,
  GitHubSourcePlan,
  GitHubSourceRemote,
  GitSource,
  ResolveGitHubSourceOptions,
  ResolveGitHubSourceOriginOptions,
  ResolveGitHubTokenOptions,
} from './vercel/source.js';
export {
  createVercelTerminalAdapter,
} from './vercel/terminal.js';
export type {
  VercelInteractiveSandbox,
  VercelTerminalAdapter,
  VercelTerminalAdapterDependencies,
  VercelTerminalFailure,
  VercelTerminalInput,
  VercelTerminalOptions,
  VercelTerminalOutput,
  VercelTerminalResult,
  VercelTerminalSize,
  VercelTerminalStreams,
  VercelTerminalTimeoutOptions,
  VercelTerminalTimeoutScheduler,
  VercelTerminalWebSocket,
} from './vercel/terminal.js';
export type {
  DevboxProvider,
  DisplayCredentialsResult,
  ProviderActionResult,
  ProviderBranchRequest,
  ProviderListRequest,
  ProviderInput,
  ProviderName,
  ProviderOutput,
  ProviderRequestContext,
  ProviderUrlRequest,
  SupportedDisplayCredentials,
  UnsupportedDisplayCredentials,
} from './types.js';
export { ProviderOperationError, ProviderUsageError } from './types.js';
export type { ProviderRegistry } from './registry.js';
