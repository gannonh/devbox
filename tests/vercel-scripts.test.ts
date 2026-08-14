import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseFullyQualifiedVcrReference } from '../scripts/vercel/smoke-contract.mjs';

const execFileAsync = promisify(execFile);
const digest = 'sha256:' + 'a'.repeat(64);
const baseDigest = 'sha256:' + 'b'.repeat(64);
const reference = `vcr.vercel.com/publisher-team/publisher-project/devbox@${digest}`;

async function runNode(
  script: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  input?: string,
) {
  try {
    const child = execFileAsync(process.execPath, [script, ...args], {
      env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    if (input !== undefined) {
      // execFileAsync exposes the child process on the promise returned by promisify.
      (child as typeof child & { child?: { stdin: NodeJS.WritableStream } }).child?.stdin.end(input);
    }
    const result = await child;
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; signal?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      signal: failure.signal,
    };
  }
}

describe('Vercel supply-chain script boundaries', () => {
  it('accepts only fully-qualified VCR digest references at the smoke boundary', () => {
    expect(parseFullyQualifiedVcrReference(reference)).toEqual({
      registry: 'vcr.vercel.com',
      team: 'publisher-team',
      project: 'publisher-project',
      repository: 'devbox',
      digest,
    });
    expect(() => parseFullyQualifiedVcrReference(`devbox@${digest}`)).toThrow(
      'fully-qualified VCR',
    );
  });

  it('normalizes public visibility and asserts returned repository identity', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-public-'));
    try {
      const result = await runNode('scripts/vercel/assert-public-repository.mjs', {
        ...process.env,
        EXPECTED_TEAM_ID: 'team-id',
        EXPECTED_PROJECT_ID: 'project-id',
        EXPECTED_TEAM_SLUG: 'publisher-team',
        EXPECTED_PROJECT_SLUG: 'publisher-project',
        EXPECTED_REPOSITORY: 'devbox',
      },
      [],
      JSON.stringify({
        public: 'true',
        name: 'devbox',
        project: { id: 'project-id', slug: 'publisher-project' },
        owner: { id: 'team-id', slug: 'publisher-team' },
      }),
      );
      expect(result.code).toBe(0);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('verifies consumer project and team identity from API responses', async () => {
    const result = await runNode(
      'scripts/vercel/assert-project-identity.mjs',
      {
        ...process.env,
        EXPECTED_TEAM_ID: 'consumer-team-id',
        EXPECTED_TEAM_SLUG: 'consumer-team',
        EXPECTED_PROJECT_ID: 'consumer-project-id',
        EXPECTED_PROJECT_SLUG: 'consumer-project',
      },
      [],
      JSON.stringify({
        projects: { projects: [{ id: 'consumer-project-id', name: 'consumer-project', accountId: 'consumer-team-id' }] },
        teams: { teams: [{ id: 'consumer-team-id', slug: 'consumer-team' }] },
      }),
    );
    expect(result.code).toBe(0);
  });

  it('kills a VCR inspect child at the readiness deadline', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-ready-'));
    const bin = join(temp, 'bin');
    const marker = join(temp, 'child-finished');
    const fakeVercel = join(bin, 'vercel');
    try {
      await mkdir(bin);
      await writeFile(
        fakeVercel,
        `#!/bin/sh\nsleep 2\ntouch ${marker}\nprintf '{"status":"Preparing"}'\n`,
      );
      await chmod(fakeVercel, 0o755);
      const started = Date.now();
      const result = await runNode('scripts/vercel/wait-vcr-ready.mjs', {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERCEL_IMAGE_REPOSITORY: 'devbox',
        VERCEL_IMAGE_TAG: 'fixture',
        VERCEL_PUBLISHER_PROJECT_ID: 'project-id',
        READINESS_TIMEOUT_MS: '80',
        READINESS_POLL_MS: '1',
        READINESS_EVIDENCE: join(temp, 'readiness.json'),
      });
      expect(result.code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(1_000);
      await expect(access(marker, constants.F_OK)).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('promotes only after both redacted evidence reports prove exact cleanup', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-promote-valid-'));
    try {
      const sourcePath = join(temp, 'image.ts');
      const source = await readFile('src/providers/vercel/image.ts', 'utf8');
      await writeFile(sourcePath, source);
      const evidence = (role: string, teamId: string, projectId: string) => ({
        redacted: true,
        role,
        scope: { teamId, projectId },
        imageReference: reference,
        expectedDigest: digest,
        checks: [{ name: 'all', ok: true }],
        sessionStates: [{ phase: 'after-stop', states: [{ id: `${role}-session`, status: 'stopped' }] }],
        terminalSession: { commandId: `${role}-command`, exitCode: 0, state: 'completed' },
        snapshots: [],
        cleanup: {
          stopped: true,
          deleted: true,
          deletionVerified: true,
          snapshotsCleaned: true,
          finalSessionStatesTerminal: true,
          residualNonDeletedSnapshots: [],
        },
      });
      const publisherEvidence = join(temp, 'publisher.json');
      const consumerEvidence = join(temp, 'consumer.json');
      await writeFile(publisherEvidence, JSON.stringify(evidence('publisher', 'publisher-team-id', 'publisher-project-id')));
      await writeFile(consumerEvidence, JSON.stringify(evidence('consumer', 'consumer-team-id', 'consumer-project-id')));
      const result = await runNode(
        'scripts/vercel/promote-image.mjs',
        { ...process.env, VERCEL_IMAGE_PIN_FILE: sourcePath },
        [
          '--reference', reference,
          '--base-reference', `vcr.vercel.com/vercel/sandbox/universal@${baseDigest}`,
          '--source-commit', '4af448f5daba0f9daf02071250f4f5ad389c80df',
          '--publisher-url', 'https://github.com/gannonh/devbox/actions/runs/100#publisher-smoke',
          '--consumer-url', 'https://github.com/gannonh/devbox/actions/runs/101#consumer-smoke',
          '--publisher-team', 'publisher-team', '--publisher-project', 'publisher-project',
          '--consumer-team', 'consumer-team', '--consumer-project', 'consumer-project',
          '--publisher-team-id', 'publisher-team-id', '--publisher-project-id', 'publisher-project-id',
          '--consumer-team-id', 'consumer-team-id', '--consumer-project-id', 'consumer-project-id',
          '--publisher-evidence', publisherEvidence, '--consumer-evidence', consumerEvidence,
        ],
      );
      expect(result.code).toBe(0);
      const promoted = await readFile(sourcePath, 'utf8');
      expect(promoted).toContain("publisherSmokeStatus: 'passed'");
      expect(promoted).toContain('crossProjectVerified: true');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('rejects promotion when redacted smoke evidence is not valid', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-promote-'));
    try {
      const sourcePath = join(temp, 'image.ts');
      const source = await readFile('src/providers/vercel/image.ts', 'utf8');
      await writeFile(sourcePath, source);
      const invalidEvidence = join(temp, 'invalid.json');
      await writeFile(invalidEvidence, JSON.stringify({ redacted: false }));
      const result = await runNode(
        'scripts/vercel/promote-image.mjs',
        {
          ...process.env,
          VERCEL_IMAGE_PIN_FILE: sourcePath,
        },
        [
          '--reference', reference,
          '--base-reference', `vcr.vercel.com/vercel/sandbox/universal@${baseDigest}`,
          '--source-commit', '4af448f5daba0f9daf02071250f4f5ad389c80df',
          '--publisher-url', 'https://github.com/gannonh/devbox/actions/runs/100#publisher-smoke',
          '--consumer-url', 'https://github.com/gannonh/devbox/actions/runs/101#consumer-smoke',
          '--publisher-team', 'publisher-team',
          '--publisher-project', 'publisher-project',
          '--consumer-team', 'consumer-team',
          '--consumer-project', 'consumer-project',
          '--publisher-team-id', 'publisher-team-id',
          '--publisher-project-id', 'publisher-project-id',
          '--consumer-team-id', 'consumer-team-id',
          '--consumer-project-id', 'consumer-project-id',
          '--publisher-evidence', invalidEvidence,
          '--consumer-evidence', invalidEvidence,
        ],
      );
      expect(result.code).not.toBe(0);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

async function mkdir(path: string): Promise<void> {
  const { mkdir: makeDirectory } = await import('node:fs/promises');
  await makeDirectory(path, { recursive: true });
}
