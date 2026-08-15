export interface VercelIdentityTags {
  provider: string;
  repository: string;
  branch: string;
  version: string;
  identity: string;
}

export interface VercelMetadataIdentity {
  name: string;
  repository: string;
  branch: string;
  packageVersion: string;
  tags: VercelIdentityTags;
}

export interface VercelResidualMetadata {
  sandboxIds?: string[];
  snapshotIds?: string[];
  reason?: string;
}

export interface VercelCreateConfiguration {
  imageReference: string;
  sourceUrl: string;
  sourceRevision: string;
  requestedBranch: string;
  needsBranchSetup: boolean;
  persistent: true;
  keepLastSnapshots: 1;
  timeoutMs: number;
}

export interface VercelMetadataInput {
  teamId: string;
  projectId: string;
  identity?: VercelMetadataIdentity;
  sandboxId?: string;
  snapshotIds?: string[];
  residual?: VercelResidualMetadata;
  configuration?: VercelCreateConfiguration;
}

export interface VercelMetadata extends VercelMetadataInput {
  schemaVersion: 1;
  provider: string;
  repoKeyHash: string;
}

const INPUT_FIELDS = [
  'teamId',
  'projectId',
  'identity',
  'sandboxId',
  'snapshotIds',
  'residual',
  'configuration',
] as const;
const STORED_FIELDS = [
  'schemaVersion',
  'provider',
  'repoKeyHash',
  ...INPUT_FIELDS,
] as const;
const IDENTITY_FIELDS = ['name', 'repository', 'branch', 'packageVersion', 'tags'] as const;
const TAG_FIELDS = ['provider', 'repository', 'branch', 'version', 'identity'] as const;
const RESIDUAL_FIELDS = ['sandboxIds', 'snapshotIds', 'reason'] as const;
const CONFIGURATION_FIELDS = [
  'imageReference',
  'sourceUrl',
  'sourceRevision',
  'requestedBranch',
  'needsBranchSetup',
  'persistent',
  'keepLastSnapshots',
  'timeoutMs',
] as const;

export function validateMetadataInput(value: unknown): VercelMetadataInput {
  const input = expectRecord(value, 'Vercel metadata input');
  assertExactKeys(input, INPUT_FIELDS, ['teamId', 'projectId'], 'Vercel metadata input');
  return {
    teamId: requireString(input.teamId, 'teamId'),
    projectId: requireString(input.projectId, 'projectId'),
    ...(input.identity === undefined ? {} : { identity: parseIdentity(input.identity) }),
    ...(input.sandboxId === undefined ? {} : { sandboxId: requireString(input.sandboxId, 'sandboxId') }),
    ...(input.snapshotIds === undefined ? {} : { snapshotIds: parseStringArray(input.snapshotIds, 'snapshotIds') }),
    ...(input.residual === undefined ? {} : { residual: parseResidual(input.residual) }),
    ...(input.configuration === undefined ? {} : { configuration: parseConfiguration(input.configuration) }),
  };
}

export function parseStoredMetadata(
  value: unknown,
  expectedProvider: string,
  expectedRepoKeyHash: string,
): VercelMetadata {
  const stored = expectRecord(value, 'Vercel metadata');
  assertExactKeys(stored, STORED_FIELDS, ['schemaVersion', 'provider', 'repoKeyHash', 'teamId', 'projectId'], 'Vercel metadata');
  if (stored.schemaVersion !== 1) {
    throw new Error('Vercel metadata schemaVersion must be 1');
  }
  const provider = requireString(stored.provider, 'provider');
  const repoKeyHash = requireString(stored.repoKeyHash, 'repoKeyHash');
  if (provider !== expectedProvider) {
    throw new Error(`Vercel metadata provider mismatch: expected ${expectedProvider}`);
  }
  if (repoKeyHash !== expectedRepoKeyHash) {
    throw new Error('Vercel metadata repo key mismatch');
  }
  const input = validateMetadataInput({
    teamId: stored.teamId,
    projectId: stored.projectId,
    ...(stored.identity === undefined ? {} : { identity: stored.identity }),
    ...(stored.sandboxId === undefined ? {} : { sandboxId: stored.sandboxId }),
    ...(stored.snapshotIds === undefined ? {} : { snapshotIds: stored.snapshotIds }),
    ...(stored.residual === undefined ? {} : { residual: stored.residual }),
    ...(stored.configuration === undefined ? {} : { configuration: stored.configuration }),
  });
  return { schemaVersion: 1, provider, repoKeyHash, ...input };
}

export function serializeMetadata(
  value: unknown,
  provider: string,
  repoKeyHash: string,
): string {
  const input = validateMetadataInput(value);
  return JSON.stringify({ schemaVersion: 1, provider, repoKeyHash, ...input }) + '\n';
}

function parseIdentity(value: unknown): VercelMetadataIdentity {
  const identity = expectRecord(value, 'Vercel metadata identity');
  assertExactKeys(identity, IDENTITY_FIELDS, IDENTITY_FIELDS, 'Vercel metadata identity');
  return {
    name: requireString(identity.name, 'identity.name'),
    repository: requireString(identity.repository, 'identity.repository'),
    branch: requireString(identity.branch, 'identity.branch'),
    packageVersion: requireString(identity.packageVersion, 'identity.packageVersion'),
    tags: parseTags(identity.tags),
  };
}

function parseTags(value: unknown): VercelIdentityTags {
  const tags = expectRecord(value, 'identity.tags');
  assertExactKeys(tags, TAG_FIELDS, TAG_FIELDS, 'identity.tags');
  return {
    provider: requireString(tags.provider, 'identity.tags.provider'),
    repository: requireString(tags.repository, 'identity.tags.repository'),
    branch: requireString(tags.branch, 'identity.tags.branch'),
    version: requireString(tags.version, 'identity.tags.version'),
    identity: requireString(tags.identity, 'identity.tags.identity'),
  };
}

function parseResidual(value: unknown): VercelResidualMetadata {
  const residual = expectRecord(value, 'Vercel metadata residual');
  assertExactKeys(residual, RESIDUAL_FIELDS, [], 'Vercel metadata residual');
  return {
    ...(residual.sandboxIds === undefined ? {} : { sandboxIds: parseStringArray(residual.sandboxIds, 'residual.sandboxIds') }),
    ...(residual.snapshotIds === undefined ? {} : { snapshotIds: parseStringArray(residual.snapshotIds, 'residual.snapshotIds') }),
    ...(residual.reason === undefined ? {} : { reason: requireString(residual.reason, 'residual.reason') }),
  };
}

function parseConfiguration(value: unknown): VercelCreateConfiguration {
  const configuration = expectRecord(value, 'Vercel metadata configuration');
  assertExactKeys(
    configuration,
    CONFIGURATION_FIELDS,
    CONFIGURATION_FIELDS,
    'Vercel metadata configuration',
  );
  if (configuration.needsBranchSetup !== true && configuration.needsBranchSetup !== false) {
    throw new Error('Metadata configuration.needsBranchSetup must be a boolean');
  }
  if (configuration.persistent !== true) {
    throw new Error('Metadata configuration.persistent must be true');
  }
  if (configuration.keepLastSnapshots !== 1) {
    throw new Error('Metadata configuration.keepLastSnapshots must be 1');
  }
  if (
    typeof configuration.timeoutMs !== 'number' ||
    !Number.isFinite(configuration.timeoutMs) ||
    configuration.timeoutMs <= 0
  ) {
    throw new Error('Metadata configuration.timeoutMs must be positive');
  }
  return {
    imageReference: requireString(configuration.imageReference, 'configuration.imageReference'),
    sourceUrl: requireString(configuration.sourceUrl, 'configuration.sourceUrl'),
    sourceRevision: requireString(configuration.sourceRevision, 'configuration.sourceRevision'),
    requestedBranch: requireString(configuration.requestedBranch, 'configuration.requestedBranch'),
    needsBranchSetup: configuration.needsBranchSetup,
    persistent: true,
    keepLastSnapshots: 1,
    timeoutMs: configuration.timeoutMs,
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Metadata ${field} must be an array`);
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Metadata ${field} must be a non-empty string`);
  }
  return value.trim();
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown ${label} field(s): ${unknown.join(', ')}`);
  }
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new Error(`Missing ${label} field(s): ${missing.join(', ')}`);
  }
}
