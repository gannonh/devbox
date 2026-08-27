export {
  createVercelBranchMetadataStore,
  createVercelMetadataStore,
  createVercelScopeMetadataStore,
} from './metadata-store.js';
export type {
  VercelBranchMetadataStore,
  VercelMetadataStore,
  VercelMetadataStoreOptions,
  VercelScopeMetadataStore,
} from './metadata-store.js';
export type {
  MetadataLock,
  MetadataLockOptions,
} from './metadata-lock.js';
export {
  patchBranchMetadata,
  toBranchMetadataInput,
  withAppPortFields,
} from './metadata-schema.js';
export type {
  VercelIdentityTags,
  VercelAppPortSelection,
  VercelPendingAppPorts,
  VercelRelayMappingRecord,
  VercelRelayState,
  VercelCreateConfiguration,
  VercelMetadata,
  VercelMetadataIdentity,
  VercelMetadataInput,
  VercelResidualMetadata,
  VercelDisplayCredentials,
  VercelPausedSnapshot,
  VercelBranchMetadata,
  VercelBranchMetadataInput,
  VercelScopeMetadata,
  VercelScopeMetadataInput,
} from './metadata-schema.js';
