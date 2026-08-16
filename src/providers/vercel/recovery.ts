import type { VercelCredentials } from './auth.js';
import type { SandboxListRecord, VercelSandboxClient } from './client.js';
import { VercelLifecycleError } from './lifecycle.js';
import { createVercelBranchTag, createVercelRepositoryTag } from './identity.js';
import type { VercelBranchMetadataStore, VercelMetadataIdentity } from './metadata.js';
import type { GitHubSourceRemote } from './source.js';

export interface RecoveredBranchSandbox {
  identity: VercelMetadataIdentity;
  sandboxId: string;
  snapshotIds?: string[];
}

export async function recoverMissingBranchSandbox(
  client: VercelSandboxClient,
  origin: GitHubSourceRemote,
  branch: string,
  credentials: VercelCredentials,
): Promise<RecoveredBranchSandbox | undefined> {
  const repositoryTag = createVercelRepositoryTag(origin.canonical);
  const branchTag = createVercelBranchTag(branch);
  const records = await client.listSandboxes({
    credentials,
    tags: { provider: 'vercel', repository: repositoryTag },
  });
  const matches = records.filter((record) => isRecoveryCandidate(record, repositoryTag, branchTag));
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
    sandboxId: record.name,
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

export async function seedRecoveryMetadata(
  branchStore: VercelBranchMetadataStore,
  identity: VercelMetadataIdentity,
  sandboxId: string,
  snapshotIds?: string[],
): Promise<void> {
  await branchStore.withLock(async () => {
    if (await branchStore.read()) return;
    await branchStore.write({
      identity,
      sandboxId,
      ...(snapshotIds === undefined ? {} : { snapshotIds }),
    });
  });
}

function isRecoveryCandidate(
  record: SandboxListRecord,
  repositoryTag: string,
  branchTag: string,
): boolean {
  const tags = record.tags;
  if (!record.name.trim() || !tags) return false;
  const expectedKeys = ['provider', 'repository', 'branch', 'version', 'identity'];
  const actualKeys = Object.keys(tags).sort();
  if (actualKeys.length !== expectedKeys.length ||
      !actualKeys.every((key, index) => key === [...expectedKeys].sort()[index])) return false;
  return tags.provider === 'vercel'
    && tags.repository === repositoryTag
    && tags.branch === branchTag
    && Object.values(tags).every((value) => value.trim().length > 0);
}
