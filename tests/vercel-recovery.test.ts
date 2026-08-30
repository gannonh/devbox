import { describe, expect, it, vi } from 'vitest';
import { createVercelIdentity } from '../src/providers/vercel/identity.js';
import {
  listBranchIdentityMatches,
  recoverMissingBranchSandbox,
} from '../src/providers/vercel/recovery.js';
import { normalizeGitHubSourceRemote } from '../src/providers/vercel/source.js';
import type { VercelSandboxClient } from '../src/providers/vercel/client.js';

const origin = normalizeGitHubSourceRemote('https://github.com/acme/repo.git');
const credentials = {
  token: 'vercel-secret',
  teamId: 'team-1',
  projectId: 'project-1',
};
const branch = 'feature/recover';

describe('listBranchIdentityMatches', () => {
  it('returns every same-scope leftover and reports foreign-scope names without deleting', async () => {
    const first = createVercelIdentity({
      remote: origin.canonical,
      branch,
      packageVersion: '0.0.1',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    const second = createVercelIdentity({
      remote: origin.canonical,
      branch,
      packageVersion: '0.0.2',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    const foreign = createVercelIdentity({
      remote: origin.canonical,
      branch,
      packageVersion: '0.0.1',
      scope: { teamId: 'team-other', projectId: 'project-other' },
    });
    const otherBranch = createVercelIdentity({
      remote: origin.canonical,
      branch: 'feature/other',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    expect(first.tags.identity).toBe(second.tags.identity);
    expect(first.name).not.toBe(second.name);

    const client = {
      listSandboxes: vi.fn(async () => [
        { name: first.name, status: 'running' as const, persistent: true, tags: { ...first.tags }, currentSnapshotId: 'snap-a' },
        { name: second.name, status: 'stopped' as const, persistent: true, tags: { ...second.tags } },
        { name: foreign.name, status: 'running' as const, persistent: true, tags: { ...foreign.tags } },
        { name: otherBranch.name, status: 'running' as const, persistent: true, tags: { ...otherBranch.tags } },
      ]),
    } as unknown as VercelSandboxClient;

    await expect(listBranchIdentityMatches(client, origin, branch, credentials)).resolves.toEqual({
      matches: [
        expect.objectContaining({ name: first.name, currentSnapshotId: 'snap-a' }),
        expect.objectContaining({ name: second.name }),
      ],
      foreignScope: [foreign.name],
    });
    expect(client.listSandboxes).toHaveBeenCalledWith({
      credentials,
      tags: { provider: 'vercel', repository: first.tags.repository },
    });
  });
});

describe('recoverMissingBranchSandbox', () => {
  it('still refuses automatic removal when more than one live sandbox matches', async () => {
    const first = createVercelIdentity({
      remote: origin.canonical,
      branch,
      packageVersion: '0.0.1',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    const second = createVercelIdentity({
      remote: origin.canonical,
      branch,
      packageVersion: '0.0.2',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    const client = {
      listSandboxes: vi.fn(async () => [
        { name: first.name, status: 'running' as const, persistent: true, tags: { ...first.tags } },
        { name: second.name, status: 'running' as const, persistent: true, tags: { ...second.tags } },
      ]),
    } as unknown as VercelSandboxClient;

    await expect(recoverMissingBranchSandbox(client, origin, branch, credentials)).rejects.toMatchObject({
      code: 'identity_conflict',
      message: `Multiple live Vercel sandboxes match ${origin.canonical} branch ${branch}`,
    });
  });

  it('recovers a single same-scope leftover by its live name and tags', async () => {
    const own = createVercelIdentity({
      remote: origin.canonical,
      branch,
      packageVersion: '0.0.1',
      scope: { teamId: credentials.teamId, projectId: credentials.projectId },
    });
    const client = {
      listSandboxes: vi.fn(async () => [{
        name: own.name,
        status: 'running' as const,
        persistent: true,
        tags: { ...own.tags },
        currentSnapshotId: 'recovered-snapshot',
      }]),
    } as unknown as VercelSandboxClient;

    await expect(recoverMissingBranchSandbox(client, origin, branch, credentials)).resolves.toEqual({
      foreignScope: [],
      recovered: {
        snapshotIds: ['recovered-snapshot'],
        identity: {
          name: own.name,
          repository: origin.canonical,
          branch,
          packageVersion: own.tags.version,
          tags: { ...own.tags },
        },
      },
    });
  });
});
