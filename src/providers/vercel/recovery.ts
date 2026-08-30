import type { VercelCredentials } from './auth.js';
import type { SandboxListRecord, VercelSandboxClient } from './client.js';
import { VercelLifecycleError } from './lifecycle.js';
import { createVercelIdentity, type VercelSandboxIdentity } from './identity.js';
import type { VercelMetadataIdentity } from './metadata.js';
import type { GitHubSourceRemote } from './source.js';

export interface RecoveredBranchSandbox {
  identity: VercelMetadataIdentity;
  snapshotIds?: string[];
}

export interface BranchSandboxRecovery {
  /** The branch's sandbox in this Vercel scope, when one exists. */
  recovered?: RecoveredBranchSandbox;
  /**
   * Names of same-repository, same-branch sandboxes belonging to a different
   * Vercel team/project. They are never touched -- deleting another scope's
   * resources is not this command's business -- but they must be reported,
   * because `--list` shows them and silence reads as "nothing exists".
   */
  foreignScope: string[];
}

export interface BranchIdentityMatches {
  matches: SandboxListRecord[];
  foreignScope: string[];
}

/**
 * Live sandboxes for this repository and branch, split by whether their
 * identity tag matches this Vercel team/project.
 *
 * `--rm` still refuses when `matches` has more than one entry: a human must
 * pick the exact resource. CI fixture cleanup uses this listing to remove
 * each match by name without touching `foreignScope`.
 */
export async function listBranchIdentityMatches(
  client: VercelSandboxClient,
  origin: GitHubSourceRemote,
  branch: string,
  credentials: VercelCredentials,
): Promise<BranchIdentityMatches> {
  const expected = createVercelIdentity({
    remote: origin.canonical,
    branch,
    scope: { teamId: credentials.teamId, projectId: credentials.projectId },
  });
  const records = await client.listSandboxes({
    credentials,
    tags: { provider: 'vercel', repository: expected.tags.repository },
  });
  const branchRecords = records.filter((record) => isBranchRecord(record, expected));
  const matches = branchRecords.filter((record) => record.tags!.identity === expected.tags.identity);
  const foreignScope = branchRecords
    .filter((record) => record.tags!.identity !== expected.tags.identity)
    .map((record) => record.name);
  return { matches, foreignScope };
}

export async function recoverMissingBranchSandbox(
  client: VercelSandboxClient,
  origin: GitHubSourceRemote,
  branch: string,
  credentials: VercelCredentials,
): Promise<BranchSandboxRecovery> {
  const { matches, foreignScope } = await listBranchIdentityMatches(
    client,
    origin,
    branch,
    credentials,
  );
  if (matches.length > 1) {
    throw new VercelLifecycleError(
      'identity_conflict',
      `Multiple live Vercel sandboxes match ${origin.canonical} branch ${branch}`,
    );
  }
  const record = matches[0];
  if (!record) return { foreignScope };
  return {
    foreignScope,
    recovered: recoveredSandboxFromRecord(record, origin, branch),
  };
}

function recoveredSandboxFromRecord(
  record: SandboxListRecord,
  origin: GitHubSourceRemote,
  branch: string,
): RecoveredBranchSandbox {
  const tags = record.tags!;
  return {
    ...(typeof record.currentSnapshotId === 'string' && record.currentSnapshotId.trim()
      ? { snapshotIds: [record.currentSnapshotId] }
      : {}),
    identity: {
      name: record.name,
      repository: origin.canonical,
      branch,
      packageVersion: tags.version,
      tags: {
        provider: tags.provider,
        repository: tags.repository,
        branch: tags.branch,
        version: tags.version,
        identity: tags.identity,
      },
    },
  };
}

/**
 * A well-formed record for this repository and branch, whatever scope made it.
 *
 * The identity comparison stays with the caller: a foreign-scope record is a
 * real sandbox for this branch that this command must report and must not
 * touch, and collapsing the two cases here is what made removal claim nothing
 * existed.
 */
function isBranchRecord(record: SandboxListRecord, expected: VercelSandboxIdentity): boolean {
  const tags = record.tags;
  if (!record.name.trim() || !tags) return false;
  const expectedKeys = ['provider', 'repository', 'branch', 'version', 'identity'];
  const actualKeys = Object.keys(tags).sort();
  if (actualKeys.length !== expectedKeys.length ||
      !actualKeys.every((key, index) => key === [...expectedKeys].sort()[index])) return false;
  return tags.provider === 'vercel'
    && tags.repository === expected.tags.repository
    && tags.branch === expected.tags.branch
    && Object.values(tags).every((value) => value.trim().length > 0);
}
