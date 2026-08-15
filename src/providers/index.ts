export {
  createProviderRegistry,
  defaultProviderRegistry,
  getProvider,
  resolveProvider,
} from './registry.js';
export { createLocalProvider } from './local/provider.js';
export { createUnavailableProvider } from './unavailable.js';
export {
  confirmVercelScope,
  renderVercelScope,
  resolveVercelCredentials,
} from './vercel/auth.js';
export type {
  CredentialResolutionOptions,
  DeviceAuthContext,
  DeviceAuthPrimitives,
  DeviceAuthResult,
  ScopeConfirmationBoundary,
  VercelCredentials,
  VercelScope,
} from './vercel/auth.js';
export {
  createVercelMetadataStore,
} from './vercel/metadata.js';
export type {
  MetadataLock,
  MetadataLockOptions,
  VercelCreateConfiguration,
  VercelIdentityTags,
  VercelMetadata,
  VercelMetadataIdentity,
  VercelMetadataInput,
  VercelMetadataStore,
  VercelMetadataStoreOptions,
  VercelResidualMetadata,
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
  resolveGitHubToken,
  selectGitHubRevision,
} from './vercel/source.js';
export type {
  GitHubRevisionSelection,
  GitHubSourcePlan,
  GitHubSourceRemote,
  GitSource,
  ResolveGitHubSourceOptions,
  ResolveGitHubTokenOptions,
} from './vercel/source.js';
export type {
  DevboxProvider,
  DisplayCredentialsResult,
  ProviderActionResult,
  ProviderBranchRequest,
  ProviderListRequest,
  ProviderName,
  ProviderRequestContext,
  ProviderUrlRequest,
  SupportedDisplayCredentials,
  UnsupportedDisplayCredentials,
} from './types.js';
export { ProviderOperationError, ProviderUsageError } from './types.js';
export type { ProviderRegistry } from './registry.js';
