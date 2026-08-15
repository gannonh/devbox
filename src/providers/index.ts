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
