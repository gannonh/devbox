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

export async function recoverMissingBranchSandbox(
  client: VercelSandboxClient,
  origin: GitHubSourceRemote,
  branch: string,
  credentials: VercelCredentials,
): Promise<RecoveredBranchSandbox | undefined> {
  const expected = createVercelIdentity({
    remote: origin.canonical,
    branch,
    scope: { teamId: credentials.teamId, projectId: credentials.projectId },
  });
  const records = await client.listSandboxes({
    credentials,
    tags: { provider: 'vercel', repository: expected.tags.repository },
  });
  const matches = records.filter((record) => isRecoveryCandidate(record, expected));
  if (matches.length > 1) {
    throw new VercelLifecycleError(
      'identity_conflict',
      `Multiple live Vercel sandboxes match ${origin.canonical} branch ${branch}`,
    );
  }
  const record = matches[0];
  if (!record) return undefined;
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

function isRecoveryCandidate(record: SandboxListRecord, expected: VercelSandboxIdentity): boolean {
  const tags = record.tags;
  if (!record.name.trim() || !tags) return false;
  const expectedKeys = ['provider', 'repository', 'branch', 'version', 'identity'];
  const actualKeys = Object.keys(tags).sort();
  if (actualKeys.length !== expectedKeys.length ||
      !actualKeys.every((key, index) => key === [...expectedKeys].sort()[index])) return false;
  return tags.provider === 'vercel'
    && tags.repository === expected.tags.repository
    && tags.branch === expected.tags.branch
    && tags.identity === expected.tags.identity
    && Object.values(tags).every((value) => value.trim().length > 0);
}
