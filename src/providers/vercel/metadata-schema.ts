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

export interface VercelDisplayCredentials {
  username: 'devbox';
  password: string;
  rotating?: boolean;
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

export interface VercelScopeMetadataInput {
  teamId: string;
  projectId: string;
}

export interface VercelScopeMetadata extends VercelScopeMetadataInput {
  schemaVersion: 2;
  metadataKind: 'scope';
  provider: string;
  repoKeyHash: string;
}

/**
 * A committed app-port selection.
 *
 * Bound to the exact remote revision, the candidate fingerprint, and the
 * detector version so a resume can re-apply the same public routes without
 * prompting, and a changed project re-prompts instead of silently reusing a
 * selection that no longer describes the checkout.
 */
export interface VercelAppPortSelection {
  /** App ports the user accepted; empty means the candidates were rejected. */
  selected: number[];
  /** The full port set applied to the Sandbox, including reserved noVNC. */
  applied: number[];
  fingerprint: string;
  detectorVersion: number;
  revision: string;
}

/**
 * A route update that has been decided but not yet confirmed committed.
 *
 * Written before the update call and cleared after it, so a crash between the
 * two always leaves the actual Sandbox route set reconcilable against a
 * recorded `previous`/`desired` pair rather than untracked.
 */
export interface VercelPendingAppPorts {
  previous: number[];
  desired: number[];
  selected: number[];
  fingerprint: string;
  detectorVersion: number;
  revision: string;
}

export interface VercelBranchMetadataInput {
  identity?: VercelMetadataIdentity;
  sandboxId?: string;
  snapshotIds?: string[];
  residual?: VercelResidualMetadata;
  configuration?: VercelCreateConfiguration;
  displayCredentials?: VercelDisplayCredentials;
  appPorts?: VercelAppPortSelection;
  pendingAppPorts?: VercelPendingAppPorts;
}

export interface VercelBranchMetadata extends VercelBranchMetadataInput {
  schemaVersion: 2;
  metadataKind: 'branch';
  provider: string;
  repoKeyHash: string;
}

/**
 * Copy every optional branch field into a write input.
 *
 * Metadata `write` replaces the whole document; omitting a field clears it.
 * Features that patch one concern (display credentials, app ports) must start
 * from this helper so they cannot wipe another feature's durable state.
 */
export function toBranchMetadataInput(metadata: VercelBranchMetadata): VercelBranchMetadataInput {
  return {
    ...(metadata.identity === undefined ? {} : { identity: metadata.identity }),
    ...(metadata.sandboxId === undefined ? {} : { sandboxId: metadata.sandboxId }),
    ...(metadata.snapshotIds === undefined ? {} : { snapshotIds: metadata.snapshotIds }),
    ...(metadata.residual === undefined ? {} : { residual: metadata.residual }),
    ...(metadata.configuration === undefined ? {} : { configuration: metadata.configuration }),
    ...(metadata.displayCredentials === undefined ? {} : { displayCredentials: metadata.displayCredentials }),
    ...(metadata.appPorts === undefined ? {} : { appPorts: metadata.appPorts }),
    ...(metadata.pendingAppPorts === undefined ? {} : { pendingAppPorts: metadata.pendingAppPorts }),
  };
}

/**
 * Rebuild a branch write with explicit app-port fields.
 *
 * `undefined` clears that field (omit-on-write). Other branch fields are
 * preserved from `metadata` when present.
 */
export function withAppPortFields(
  metadata: VercelBranchMetadata | null,
  appPorts: VercelAppPortSelection | undefined,
  pendingAppPorts: VercelPendingAppPorts | undefined,
): VercelBranchMetadataInput {
  const {
    appPorts: _ignoredAppPorts,
    pendingAppPorts: _ignoredPending,
    ...rest
  } = metadata === null ? {} : toBranchMetadataInput(metadata);
  return {
    ...rest,
    ...(appPorts === undefined ? {} : { appPorts }),
    ...(pendingAppPorts === undefined ? {} : { pendingAppPorts }),
  };
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

const SCOPE_INPUT_FIELDS = ['teamId', 'projectId'] as const;
const SCOPE_STORED_FIELDS = ['schemaVersion', 'metadataKind', 'provider', 'repoKeyHash', ...SCOPE_INPUT_FIELDS] as const;
const BRANCH_INPUT_FIELDS = [
  'identity',
  'sandboxId',
  'snapshotIds',
  'residual',
  'configuration',
  'displayCredentials',
  'appPorts',
  'pendingAppPorts',
] as const;
const APP_PORT_SELECTION_FIELDS = [
  'selected',
  'applied',
  'fingerprint',
  'detectorVersion',
  'revision',
] as const;
const PENDING_APP_PORT_FIELDS = [
  'previous',
  'desired',
  'selected',
  'fingerprint',
  'detectorVersion',
  'revision',
] as const;
const BRANCH_STORED_FIELDS = ['schemaVersion', 'metadataKind', 'provider', 'repoKeyHash', ...BRANCH_INPUT_FIELDS] as const;

export function validateScopeMetadataInput(value: unknown): VercelScopeMetadataInput {
  const input = expectRecord(value, 'Vercel scope metadata input');
  assertExactKeys(input, SCOPE_INPUT_FIELDS, SCOPE_INPUT_FIELDS, 'Vercel scope metadata input');
  return {
    teamId: requireString(input.teamId, 'teamId'),
    projectId: requireString(input.projectId, 'projectId'),
  };
}

export function parseStoredScopeMetadata(
  value: unknown,
  expectedProvider: string,
  expectedRepoKeyHash: string,
): VercelScopeMetadata {
  const stored = expectRecord(value, 'Vercel scope metadata');
  assertExactKeys(stored, SCOPE_STORED_FIELDS, SCOPE_STORED_FIELDS, 'Vercel scope metadata');
  assertMetadataHeader(stored, expectedProvider, expectedRepoKeyHash, 'scope');
  return {
    schemaVersion: 2,
    metadataKind: 'scope',
    provider: expectedProvider,
    repoKeyHash: expectedRepoKeyHash,
    ...validateScopeMetadataInput({ teamId: stored.teamId, projectId: stored.projectId }),
  };
}

export function serializeScopeMetadata(
  value: unknown,
  provider: string,
  repoKeyHash: string,
): string {
  const input = validateScopeMetadataInput(value);
  return JSON.stringify({
    schemaVersion: 2,
    metadataKind: 'scope',
    provider,
    repoKeyHash,
    ...input,
  }) + '\n';
}

export function validateBranchMetadataInput(value: unknown): VercelBranchMetadataInput {
  const input = expectRecord(value, 'Vercel branch metadata input');
  assertExactKeys(input, BRANCH_INPUT_FIELDS, [], 'Vercel branch metadata input');
  return {
    ...(input.identity === undefined ? {} : { identity: parseIdentity(input.identity) }),
    ...(input.sandboxId === undefined ? {} : { sandboxId: requireString(input.sandboxId, 'sandboxId') }),
    ...(input.snapshotIds === undefined ? {} : { snapshotIds: parseStringArray(input.snapshotIds, 'snapshotIds') }),
    ...(input.residual === undefined ? {} : { residual: parseResidual(input.residual) }),
    ...(input.configuration === undefined ? {} : { configuration: parseConfiguration(input.configuration) }),
    ...(input.displayCredentials === undefined ? {} : { displayCredentials: parseDisplayCredentials(input.displayCredentials) }),
    ...(input.appPorts === undefined ? {} : { appPorts: parseAppPortSelection(input.appPorts) }),
    ...(input.pendingAppPorts === undefined ? {} : { pendingAppPorts: parsePendingAppPorts(input.pendingAppPorts) }),
  };
}

export function parseStoredBranchMetadata(
  value: unknown,
  expectedProvider: string,
  expectedRepoKeyHash: string,
): VercelBranchMetadata {
  const stored = expectRecord(value, 'Vercel branch metadata');
  assertExactKeys(stored, BRANCH_STORED_FIELDS, BRANCH_STORED_FIELDS.slice(0, 4), 'Vercel branch metadata');
  assertMetadataHeader(stored, expectedProvider, expectedRepoKeyHash, 'branch');
  return {
    schemaVersion: 2,
    metadataKind: 'branch',
    provider: expectedProvider,
    repoKeyHash: expectedRepoKeyHash,
    ...validateBranchMetadataInput(Object.fromEntries(
      BRANCH_INPUT_FIELDS
        .filter((field) => stored[field] !== undefined)
        .map((field) => [field, stored[field]]),
    )),
  };
}

export function serializeBranchMetadata(
  value: unknown,
  provider: string,
  repoKeyHash: string,
): string {
  const input = validateBranchMetadataInput(value);
  return JSON.stringify({
    schemaVersion: 2,
    metadataKind: 'branch',
    provider,
    repoKeyHash,
    ...input,
  }) + '\n';
}

function assertMetadataHeader(
  stored: Record<string, unknown>,
  expectedProvider: string,
  expectedRepoKeyHash: string,
  expectedKind: 'scope' | 'branch',
): void {
  if (stored.schemaVersion !== 2) throw new Error('Vercel metadata schemaVersion must be 2');
  if (stored.metadataKind !== expectedKind) throw new Error(`Vercel metadata kind mismatch: expected ${expectedKind}`);
  if (stored.provider !== expectedProvider) throw new Error(`Vercel metadata provider mismatch: expected ${expectedProvider}`);
  if (stored.repoKeyHash !== expectedRepoKeyHash) throw new Error('Vercel metadata repo key mismatch');
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

function parseDisplayCredentials(value: unknown): VercelDisplayCredentials {
  const credentials = expectRecord(value, 'Vercel display credentials');
  assertExactKeys(
    credentials,
    ['username', 'password', 'rotating'],
    ['username', 'password'],
    'Vercel display credentials',
  );
  if (credentials.username !== 'devbox') {
    throw new Error('Vercel display credentials username must be devbox');
  }
  const password = requireString(credentials.password, 'displayCredentials.password');
  if (!/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error('Metadata displayCredentials.password must use URL-safe characters');
  }
  if (credentials.rotating !== undefined && typeof credentials.rotating !== 'boolean') {
    throw new Error('Metadata displayCredentials.rotating must be a boolean');
  }
  return {
    username: 'devbox',
    password,
    ...(credentials.rotating === undefined ? {} : { rotating: credentials.rotating }),
  };
}

function parseAppPortSelection(value: unknown): VercelAppPortSelection {
  const selection = expectRecord(value, 'Vercel app port selection');
  assertExactKeys(
    selection,
    APP_PORT_SELECTION_FIELDS,
    APP_PORT_SELECTION_FIELDS,
    'Vercel app port selection',
  );
  return {
    selected: parsePortArray(selection.selected, 'appPorts.selected'),
    applied: parsePortArray(selection.applied, 'appPorts.applied'),
    fingerprint: parseFingerprint(selection.fingerprint, 'appPorts.fingerprint'),
    detectorVersion: parseDetectorVersion(selection.detectorVersion, 'appPorts.detectorVersion'),
    revision: parseRevision(selection.revision, 'appPorts.revision'),
  };
}

function parsePendingAppPorts(value: unknown): VercelPendingAppPorts {
  const pending = expectRecord(value, 'Vercel pending app ports');
  assertExactKeys(
    pending,
    PENDING_APP_PORT_FIELDS,
    PENDING_APP_PORT_FIELDS,
    'Vercel pending app ports',
  );
  return {
    previous: parsePortArray(pending.previous, 'pendingAppPorts.previous'),
    desired: parsePortArray(pending.desired, 'pendingAppPorts.desired'),
    selected: parsePortArray(pending.selected, 'pendingAppPorts.selected'),
    fingerprint: parseFingerprint(pending.fingerprint, 'pendingAppPorts.fingerprint'),
    detectorVersion: parseDetectorVersion(pending.detectorVersion, 'pendingAppPorts.detectorVersion'),
    revision: parseRevision(pending.revision, 'pendingAppPorts.revision'),
  };
}

function parsePortArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new Error(`Metadata ${field} must be an array`);
  const ports: number[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1 || entry > 65_535) {
      throw new Error(`Metadata ${field}[${index}] must be an integer port in 1..65535`);
    }
    if (ports.includes(entry)) throw new Error(`Metadata ${field}[${index}] duplicates port ${entry}`);
    ports.push(entry);
  }
  return ports;
}

function parseFingerprint(value: unknown, field: string): string {
  const fingerprint = requireString(value, field);
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`Metadata ${field} must be a SHA-256 hex digest`);
  }
  return fingerprint;
}

function parseDetectorVersion(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Metadata ${field} must be a positive integer`);
  }
  return value;
}

function parseRevision(value: unknown, field: string): string {
  const revision = requireString(value, field);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`Metadata ${field} must be a 40-character commit SHA`);
  }
  return revision;
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
  const sourceUrl = requireString(configuration.sourceUrl, 'configuration.sourceUrl');
  assertSecretFreeSourceUrl(sourceUrl);
  return {
    imageReference: requireString(configuration.imageReference, 'configuration.imageReference'),
    sourceUrl,
    sourceRevision: requireString(configuration.sourceRevision, 'configuration.sourceRevision'),
    requestedBranch: requireString(configuration.requestedBranch, 'configuration.requestedBranch'),
    needsBranchSetup: configuration.needsBranchSetup,
    persistent: true,
    keepLastSnapshots: 1,
    timeoutMs: configuration.timeoutMs,
  };
}

function assertSecretFreeSourceUrl(sourceUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return;
  }
  if (parsed.username || parsed.password) {
    throw new Error('Metadata configuration.sourceUrl must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Metadata configuration.sourceUrl must not contain query or fragment components');
  }
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
