import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  parseFullyQualifiedVcrReference,
  REQUIRED_SMOKE_CHECKS,
  REQUIRED_SMOKE_TIMINGS,
} from '../scripts/vercel/smoke-contract.mjs';
import { fetchWithTimeout } from '../scripts/vercel/http-probe.mjs';
import { verifySandboxDeleted } from '../scripts/vercel/sandbox-cleanup.mjs';

const execFileAsync = promisify(execFile);
const digest = 'sha256:' + 'a'.repeat(64);
const baseDigest = 'sha256:' + 'b'.repeat(64);
const reference = `vcr.vercel.com/publisher-team/publisher-project/devbox@${digest}`;

function validEvidence(role: string, teamId: string, projectId: string) {
  return {
    redacted: true,
    failed: false,
    role,
    scope: { teamId, projectId },
    imageReference: reference,
    expectedDigest: digest,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.001Z',
    durationMs: 1,
    smokeUrl: role === 'publisher'
      ? 'https://github.com/gannonh/devbox/actions/runs/100#publisher-smoke'
      : 'https://github.com/gannonh/devbox/actions/runs/101#consumer-smoke',
    sandboxName: `${role}-sandbox`,
    noVncUrl: `https://${role}.example.test`,
    checks: REQUIRED_SMOKE_CHECKS.map((name) => ({ name, ok: true })),
    requiredChecksComplete: true,
    timings: Object.fromEntries(REQUIRED_SMOKE_TIMINGS.map((name) => [name, {
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.001Z',
      startedEpochMs: 1767225600000,
      finishedEpochMs: 1767225600001,
      durationMs: 1,
      outcome: 'passed',
    }])),
    sessionStates: [{ phase: 'after-stop', states: [{ id: `${role}-session`, status: 'stopped' }] }],
    terminalSession: { commandId: `${role}-command`, exitCode: 0, state: 'completed' },
    snapshots: [],
    cleanup: {
      stopped: true,
      deleted: true,
      deletionVerified: true,
      snapshotsCleaned: true,
      noRunningSessionAfterDelete: true,
      finalSessionStatesTerminal: true,
      residualNonDeletedSnapshots: [],
      errors: [],
    },
  };
}

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
  it('aborts a hanging HTTP endpoint at the per-request deadline', async () => {
    const server = createServer(() => {
      // Deliberately leave the request pending; the helper must abort it.
    }).listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      await expect(fetchWithTimeout(`http://127.0.0.1:${address.port}/hang`, {}, 50)).rejects.toThrow(/timed out|aborted/i);
    } finally {
      server.close();
    }
  });

  it('retries eventual post-delete running states and performs final cleanup', async () => {
    const targets = [
      { status: 'running' },
      { status: 'stopping' },
    ];
    const lookups: boolean[] = [];
    const sessions = [
      [{ id: 'session-running', status: 'running' }],
      [{ id: 'session-stopping', status: 'stopping' }],
    ];
    let stops = 0;
    let deletes = 0;
    const result = await verifySandboxDeleted({
      timeoutMs: 1_000,
      maxAttempts: 4,
      getSandbox: async (options: { resume: boolean }) => {
        lookups.push(options.resume);
        const target = targets.shift();
        if (target) return target;
        throw { notFound: true };
      },
      listSessions: async () => sessions.shift() ?? [],
      stopSandbox: async () => { stops += 1; },
      deleteSandbox: async () => { deletes += 1; },
      sleep: async () => {},
      isNotFound: (error: unknown) => Boolean((error as { notFound?: boolean }).notFound),
    });
    expect(result).toMatchObject({ verified: true, noRunningSession: true });
    expect(lookups).toEqual([false, false, false]);
    expect(stops).toBe(2);
    expect(deletes).toBeGreaterThanOrEqual(2);
  });

  it('fails closed after bounded final cleanup when deletion never converges', async () => {
    let lookups = 0;
    let stops = 0;
    let deletes = 0;
    const result = await verifySandboxDeleted({
      timeoutMs: 1_000,
      maxAttempts: 2,
      getSandbox: async (options: { resume: boolean }) => {
        expect(options.resume).toBe(false);
        lookups += 1;
        return { status: 'running' };
      },
      listSessions: async () => [{ id: 'still-running', status: 'running' }],
      stopSandbox: async () => { stops += 1; },
      deleteSandbox: async () => { deletes += 1; },
      sleep: async () => {},
    });
    expect(result).toMatchObject({ verified: false, noRunningSession: false });
    expect(lookups).toBeGreaterThanOrEqual(3);
    expect(stops).toBeGreaterThanOrEqual(3);
    expect(deletes).toBeGreaterThanOrEqual(3);
  });

  it('requires executable working-binary probes for image and Sandbox checks', async () => {
    const status = await readFile('images/vercel/status-devbox.sh', 'utf8');
    const smoke = await readFile('scripts/vercel/smoke-sandbox.mjs', 'utf8');
    for (const probe of ['pi --version', 'claude --version', 'codex --version', 'opencode --version', 'gh --version', 'node --version', 'bun --version', 'python --version', 'chromium --version', 'Xvfb -version', 'fluxbox --version', 'x11vnc -version', 'websockify --version']) {
      expect(status).toContain(probe);
      expect(smoke).toContain(probe);
    }
    expect(status).toContain('timeout');
  });

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
        EXPECTED_PROJECT_ID: 'project-id',
        EXPECTED_REPOSITORY: 'devbox',
      },
      [],
      JSON.stringify({
        id: 'repo-id',
        projectId: 'project-id',
        name: 'devbox',
        public: 'true',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
      );
      expect(result.code).toBe(0);
      const mixed = await runNode('scripts/vercel/assert-public-repository.mjs', {
        ...process.env,
        EXPECTED_PROJECT_ID: 'project-id',
        EXPECTED_REPOSITORY: 'devbox',
      },
      [],
      JSON.stringify({
        id: 'repo-id',
        projectId: 'wrong-project',
        name: 'devbox',
        public: true,
        project: { id: 'project-id' },
      }),
      );
      expect(mixed.code).not.toBe(0);
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

  it('rejects mixed project/team identity objects', async () => {
    const result = await runNode(
      'scripts/vercel/assert-project-identity.mjs',
      {
        ...process.env,
        EXPECTED_TEAM_ID: 'team-id',
        EXPECTED_TEAM_SLUG: 'team-slug',
        EXPECTED_PROJECT_ID: 'project-id',
        EXPECTED_PROJECT_SLUG: 'project-slug',
      },
      [],
      JSON.stringify({
        projects: {
          projects: [
            { id: 'project-id', name: 'project-slug', accountId: 'other-team' },
            { id: 'other-project', name: 'other-project', accountId: 'team-id' },
          ],
        },
        teams: { teams: [{ id: 'team-id', slug: 'other-slug' }, { id: 'other-team', slug: 'team-slug' }] },
      }),
    );
    expect(result.code).not.toBe(0);
  });

  it('requires publisher team scope for readiness polling', async () => {
    const result = await runNode('scripts/vercel/wait-vcr-ready.mjs', {
      ...process.env,
      VERCEL_IMAGE_REPOSITORY: 'devbox',
      VERCEL_IMAGE_TAG: 'fixture',
      VERCEL_PUBLISHER_PROJECT_ID: 'project-id',
      VCR_READINESS_FIXTURE: '["Ready"]',
      READINESS_TIMEOUT_MS: '100',
      READINESS_POLL_MS: '1',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('VERCEL_PUBLISHER_TEAM_SLUG');
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
        VERCEL_PUBLISHER_TEAM_SLUG: 'publisher-team',
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

  it('fails redaction on an unreadable artifact path', async () => {
    const result = await runNode(
      'scripts/vercel/redact-artifacts.mjs',
      process.env,
      ['/tmp/vercel-redaction-path-that-does-not-exist'],
    );
    expect(result.code).not.toBe(0);
  });

  it('promotes only after both redacted evidence reports prove exact cleanup', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-promote-valid-'));
    try {
      const sourcePath = join(temp, 'image.ts');
      const source = await readFile('src/providers/vercel/image.ts', 'utf8');
      await writeFile(sourcePath, source);
      const evidence = (role: string, teamId: string, projectId: string) => ({
        ...validEvidence(role, teamId, projectId),
        cleanup: {
          stopped: true,
          deleted: true,
          deletionVerified: true,
          snapshotsCleaned: true,
          noRunningSessionAfterDelete: true,
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

  it('rejects minimal, failed, URL-mismatched, and timing-incomplete evidence', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-promote-forgery-'));
    try {
      const sourcePath = join(temp, 'image.ts');
      await writeFile(sourcePath, await readFile('src/providers/vercel/image.ts', 'utf8'));
      const consumer = validEvidence('consumer', 'consumer-team-id', 'consumer-project-id');
      const variants = [
        { name: 'minimal', report: { redacted: true } },
        { name: 'failed', report: { ...validEvidence('publisher', 'publisher-team-id', 'publisher-project-id'), failed: true } },
        { name: 'URL mismatch', report: { ...validEvidence('publisher', 'publisher-team-id', 'publisher-project-id'), smokeUrl: 'https://wrong.example.test' } },
        { name: 'timing incomplete', report: (() => { const report = validEvidence('publisher', 'publisher-team-id', 'publisher-project-id'); delete report.timings.create; return report; })() },
      ];
      for (const variant of variants) {
        const publisherPath = join(temp, `${variant.name.replace(/[^a-z]+/gi, '-')}-publisher.json`);
        const consumerPath = join(temp, `${variant.name.replace(/[^a-z]+/gi, '-')}-consumer.json`);
        await writeFile(publisherPath, JSON.stringify(variant.report));
        await writeFile(consumerPath, JSON.stringify(consumer));
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
            '--publisher-evidence', publisherPath, '--consumer-evidence', consumerPath,
          ],
        );
        expect(result.code, variant.name).not.toBe(0);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('rejects malformed evidence primitives and cleanup shapes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-promote-malformed-'));
    try {
      const sourcePath = join(temp, 'image.ts');
      await writeFile(sourcePath, await readFile('src/providers/vercel/image.ts', 'utf8'));
      const variants = [
        ['empty sandbox ID', (report: any) => { report.sandboxName = ''; }],
        ['non-HTTPS noVNC URL', (report: any) => { report.noVncUrl = 'http://sandbox.example.test'; }],
        ['invalid aggregate timestamp', (report: any) => { report.startedAt = 'not-a-date'; }],
        ['reverse aggregate timestamps', (report: any) => { report.finishedAt = '2025-01-01T00:00:00.000Z'; }],
        ['negative stage duration', (report: any) => { report.timings.create.durationMs = -1; }],
        ['malformed cleanup errors', (report: any) => { report.cleanup.errors = { message: 'not-an-array' }; }],
        ['empty session ID', (report: any) => { report.sessionStates[0].states[0].id = ''; }],
      ] as const;
      for (const [name, mutate] of variants) {
        const publisherPath = join(temp, `${name.replace(/[^a-z]+/gi, '-')}-publisher.json`);
        const consumerPath = join(temp, `${name.replace(/[^a-z]+/gi, '-')}-consumer.json`);
        const publisher = validEvidence('publisher', 'publisher-team-id', 'publisher-project-id');
        mutate(publisher);
        await writeFile(publisherPath, JSON.stringify(publisher));
        await writeFile(consumerPath, JSON.stringify(validEvidence('consumer', 'consumer-team-id', 'consumer-project-id')));
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
            '--publisher-evidence', publisherPath, '--consumer-evidence', consumerPath,
          ],
        );
        expect(result.code, name).not.toBe(0);
      }
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
