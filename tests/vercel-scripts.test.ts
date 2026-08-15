import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Snapshot } from '@vercel/sandbox';
import {
  parseFullyQualifiedVcrReference,
  REQUIRED_SMOKE_CHECKS,
  REQUIRED_SMOKE_TIMINGS,
} from '../scripts/vercel/smoke-contract.mjs';
import { fetchWithTimeout } from '../scripts/vercel/http-probe.mjs';
import { verifySandboxDeleted } from '../scripts/vercel/sandbox-cleanup.mjs';
import {
  applyOwnedRecoveryEvidence,
  recoverOwnedResources,
} from '../scripts/vercel/sandbox-owned-recovery.mjs';
import { deleteListedSnapshot } from '../scripts/vercel/snapshot-cleanup.mjs';

const execFileAsync = promisify(execFile);
const digest = 'sha256:' + 'a'.repeat(64);
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
      discoveryConverged: true,
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

  it('clears transient verification errors after a final non-resuming lookup proves deletion', async () => {
    const recovery: Array<{ operation: string; outcome: string }> = [];
    let lookups = 0;
    const result = await verifySandboxDeleted({
      timeoutMs: 1_000,
      maxAttempts: 2,
      getSandbox: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error('temporary lookup failure');
        throw { notFound: true };
      },
      listSessions: async () => [],
      stopSandbox: async () => {},
      deleteSandbox: async () => {},
      sleep: async () => {},
      isNotFound: (error: unknown) => Boolean((error as { notFound?: boolean }).notFound),
      onRecovery: (event: { operation: string; outcome: string }) => recovery.push(event),
    });
    expect(result).toMatchObject({ verified: true, noRunningSession: true, errors: [] });
    expect(recovery).toContainEqual(expect.objectContaining({ operation: 'post-delete lookup', outcome: 'failed' }));
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

  it('does not ship the obsolete runtime Universal digest resolver', async () => {
    await expect(access('scripts/vercel/resolve-universal-digest.mjs')).rejects.toThrow();
    const workflow = await readFile('.github/workflows/vercel-image.yml', 'utf8');
    expect(workflow).not.toContain('resolve-universal-digest.mjs');
    expect(workflow).not.toContain('universal_digest');
    expect(workflow).toContain('images/vercel/provenance.json');
  });

  it('uses live API-valid filters and bounded pages for owned cleanup', async () => {
    const source = await readFile('scripts/vercel/smoke-sandbox.mjs', 'utf8');
    const sandboxListCalls = [...source.matchAll(/Sandbox\.list\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]);
    const ownedSandboxListCalls = sandboxListCalls.filter((call) => call.includes('namePrefix'));
    expect(ownedSandboxListCalls.length).toBeGreaterThan(0);
    for (const call of ownedSandboxListCalls) expect(call).toContain("sortBy: 'name'");

    const snapshotListCalls = [...source.matchAll(/Snapshot\.list\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]);
    expect(snapshotListCalls.length).toBeGreaterThan(0);
    for (const call of snapshotListCalls) {
      const limit = call.match(/limit\s*:\s*(\d+)/)?.[1];
      expect(limit).toBeDefined();
      expect(Number(limit)).toBeLessThanOrEqual(50);
    }

    const sessionListCalls = [...source.matchAll(/\.listSessions\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]);
    expect(sessionListCalls.length).toBeGreaterThan(0);
    for (const call of sessionListCalls) {
      const limit = call.match(/limit\s*:\s*(\d+)/)?.[1];
      expect(limit).toBeDefined();
      expect(Number(limit)).toBeLessThanOrEqual(50);
    }
  });

  it('recovers owned resources discovered by tag after a lost create handle', async () => {
    const recovered: string[] = [];
    const deletedSnapshots: string[] = [];
    let sandboxPresent = true;
    let snapshotListCalls = 0;
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 2,
      backoffMs: 0,
      listSandboxes: async () => (sandboxPresent ? [{ name: 'owned-sandbox' }] : []),
      recoverSandbox: async (name: string) => {
        recovered.push(name);
        sandboxPresent = false;
      },
      listSnapshots: async () => {
        snapshotListCalls += 1;
        return snapshotListCalls === 1
          ? [{ id: 'owned-snapshot', status: 'created' }]
          : [{ id: 'owned-snapshot', status: 'deleted' }];
      },
      deleteSnapshot: async (snapshot: { id: string }) => { deletedSnapshots.push(snapshot.id); },
    });
    expect(result.errors).toEqual([]);
    expect(recovered).toEqual(['owned-sandbox']);
    expect(deletedSnapshots).toEqual(['owned-snapshot']);
    expect(result.finalSandboxes).toEqual([]);
    expect(result.discoveryConverged).toBe(true);
  });

  it('fails closed when owned collection discovery returns a broad 404', async () => {
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 2,
      backoffMs: 0,
      listSandboxes: async () => { throw { notFound: true }; },
      recoverSandbox: async () => {},
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
      isNotFound: (error: unknown) => Boolean((error as { notFound?: boolean }).notFound),
    });
    expect(result.discoveryConverged).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sandbox discovery/);
  });

  it('fails closed when owned snapshot collection discovery returns a broad 404', async () => {
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 2,
      backoffMs: 0,
      listSandboxes: async () => [],
      recoverSandbox: async () => {},
      listSnapshots: async () => { throw { notFound: true }; },
      deleteSnapshot: async () => {},
      isNotFound: (error: unknown) => Boolean((error as { notFound?: boolean }).notFound),
    });
    expect(result.snapshotsCleaned).toBe(false);
    expect(result.errors.join(' ')).toMatch(/snapshot discovery/);
  });

  it('fails closed when a recovered Sandbox remains in the final independent listing', async () => {
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 2,
      backoffMs: 0,
      listSandboxes: async () => [{ name: 'forever-present', status: 'stopped' }],
      recoverSandbox: async () => {},
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
    });
    expect(result.discoveryConverged).toBe(false);
    expect(result.residualSandboxes).toEqual([{ name: 'forever-present', status: 'stopped' }]);
    expect(result.errors.join(' ')).toMatch(/forever-present/);
  });

  it('models pinned SDK Snapshot.list results as plain metadata', async () => {
    const listed = await Snapshot.list({
      token: 'fixture-token',
      teamId: 'fixture-team',
      projectId: 'fixture-project',
      fetch: async () => new Response(JSON.stringify({
        snapshots: [{
          id: 'snapshot-metadata',
          sourceSessionId: 'session-id',
          region: 'iad1',
          status: 'created',
          sizeBytes: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
        pagination: { count: 1, next: null },
      }), { headers: { 'content-type': 'application/json' } }),
    });
    const snapshots = await listed.toArray();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe('snapshot-metadata');
    expect(snapshots[0]).not.toHaveProperty('delete');
    expect(snapshots[0]).not.toHaveProperty('snapshotId');
  });

  it('authoritatively reconciles delayed snapshot metadata after an initial delete error', async () => {
    let listCalls = 0;
    let deleteAttempts = 0;
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 3,
      backoffMs: 0,
      listSandboxes: async () => [],
      recoverSandbox: async () => {},
      listSnapshots: async () => {
        listCalls += 1;
        return listCalls === 1
          ? [{ id: 'delayed-snapshot', status: 'created' }]
          : [{ id: 'delayed-snapshot', status: 'deleted' }];
      },
      deleteSnapshot: async () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error('snapshot is still being finalized');
      },
      sleep: async () => {},
    });
    expect(result.errors).toEqual([]);
    expect(result.snapshotsCleaned).toBe(true);
    expect(result.finalSnapshots).toEqual([{ id: 'delayed-snapshot', status: 'deleted' }]);
    expect(result.residualSnapshots).toEqual([]);
    expect(listCalls).toBeGreaterThanOrEqual(3);
  });

  it('reconciles SDK-shaped snapshot metadata until every item is deleted', async () => {
    let listCalls = 0;
    const deletedIds: string[] = [];
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 4,
      backoffMs: 1,
      listSandboxes: async () => [],
      recoverSandbox: async () => {},
      listSnapshots: async () => {
        listCalls += 1;
        return listCalls < 3
          ? [{ id: 'snapshot-metadata', status: 'created' }]
          : [{ id: 'snapshot-metadata', status: 'deleted' }];
      },
      deleteSnapshot: async (snapshot: { id: string; delete?: unknown }) => {
        expect(snapshot.id).toBe('snapshot-metadata');
        expect(snapshot.delete).toBeUndefined();
        deletedIds.push(snapshot.id);
      },
      sleep: async () => {},
    });
    expect(deletedIds).toEqual(['snapshot-metadata', 'snapshot-metadata']);
    expect(result.snapshotsCleaned).toBe(true);
    expect(result.residualSnapshots).toEqual([]);
    expect(listCalls).toBeGreaterThanOrEqual(3);
  });

  it('waits for delayed owned Sandbox discovery after a lost create handle', async () => {
    let listCalls = 0;
    let sandboxPresent = false;
    let discoveredOnce = false;
    const recovered: string[] = [];
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 4,
      backoffMs: 1,
      listSandboxes: async () => {
        listCalls += 1;
        if (!discoveredOnce && listCalls >= 3) sandboxPresent = true;
        return sandboxPresent ? [{ name: 'delayed-owned-sandbox' }] : [];
      },
      recoverSandbox: async (name: string) => {
        recovered.push(name);
        discoveredOnce = true;
        sandboxPresent = false;
      },
      listSnapshots: async () => [],
      deleteSnapshot: async () => {},
      sleep: async () => {},
    });
    expect(recovered).toEqual(['delayed-owned-sandbox']);
    expect(result.discoveryConverged).toBe(true);
    expect(result.finalSandboxes).toEqual([]);
    expect(listCalls).toBeGreaterThanOrEqual(3);
  });

  it('fails closed with residual SDK-shaped snapshots that never converge', async () => {
    const result = await recoverOwnedResources({
      timeoutMs: 1_000,
      maxAttempts: 3,
      backoffMs: 1,
      listSandboxes: async () => [],
      recoverSandbox: async () => {},
      listSnapshots: async () => [{ id: 'stuck-snapshot', status: 'created' }],
      deleteSnapshot: async (snapshot: { id: string }) => {
        expect(snapshot.id).toBe('stuck-snapshot');
      },
      sleep: async () => {},
    });
    expect(result.snapshotsCleaned).toBe(false);
    expect(result.residualSnapshots).toEqual([{ id: 'stuck-snapshot', status: 'created' }]);
    expect(result.errors.join(' ')).toMatch(/stuck-snapshot/);
  });

  it('deletes actual SDK Snapshot.list metadata through Snapshot.get and instance delete', async () => {
    const credentials = { token: 'fixture-token', teamId: 'fixture-team', projectId: 'fixture-project' };
    const metadata = {
      id: 'snapshot-instance',
      sourceSessionId: 'session-id',
      region: 'iad1',
      status: 'created',
      sizeBytes: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const requests: Array<{ method: string; path: string }> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      requests.push({ method, path: url.pathname });
      if (method === 'GET' && url.pathname.endsWith('/snapshot-instance')) {
        return new Response(JSON.stringify({ snapshot: metadata }), { headers: { 'content-type': 'application/json' } });
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ snapshot: { ...metadata, status: 'deleted' } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ snapshots: [metadata], pagination: { count: 1, next: null } }), { headers: { 'content-type': 'application/json' } });
    };
    const listed = await Snapshot.list({ ...credentials, fetch });
    const [snapshot] = await listed.toArray();
    await deleteListedSnapshot({
      snapshot,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      getSnapshot: (snapshotId: string, signal: AbortSignal) => Snapshot.get({ ...credentials, snapshotId, signal, fetch }),
    });
    expect(requests).toEqual([
      { method: 'GET', path: '/api/v2/sandboxes/snapshots' },
      { method: 'GET', path: '/api/v2/sandboxes/snapshots/snapshot-instance' },
      { method: 'DELETE', path: '/api/v2/sandboxes/snapshots/snapshot-instance' },
    ]);
  });

  it('applies delayed final snapshot convergence to promotion-valid evidence', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-promote-delayed-snapshot-'));
    try {
      let listCalls = 0;
      const recovery = await recoverOwnedResources({
        timeoutMs: 1_000,
        maxAttempts: 3,
        backoffMs: 0,
        listSandboxes: async () => [],
        recoverSandbox: async () => {},
        listSnapshots: async () => {
          listCalls += 1;
          return listCalls === 1
            ? [{ id: 'promotion-snapshot', status: 'created' }]
            : [{ id: 'promotion-snapshot', status: 'deleted' }];
        },
        deleteSnapshot: async () => {},
        sleep: async () => {},
      });
      const sourcePath = join(temp, 'image.ts');
      await writeFile(sourcePath, await readFile('src/providers/vercel/image.ts', 'utf8'));
      const publisher = validEvidence('publisher', 'publisher-team-id', 'publisher-project-id') as any;
      const consumer = validEvidence('consumer', 'consumer-team-id', 'consumer-project-id') as any;
      publisher.cleanup.recovery = [{ operation: 'snapshot cleanup', outcome: 'pending-reconciliation', detail: 'initial residual' }];
      applyOwnedRecoveryEvidence(publisher, recovery);
      applyOwnedRecoveryEvidence(consumer, recovery);
      expect(publisher.cleanup.recovery).toBeUndefined();
      for (const evidence of [publisher, consumer]) {
        evidence.cleanup.stopped = true;
        evidence.cleanup.deleted = true;
        evidence.cleanup.deletionVerified = true;
        evidence.cleanup.noRunningSessionAfterDelete = true;
        evidence.cleanup.finalSessionStatesTerminal = true;
        evidence.requiredChecksComplete = true;
      }
      const publisherPath = join(temp, 'publisher.json');
      const consumerPath = join(temp, 'consumer.json');
      await writeFile(publisherPath, JSON.stringify(publisher));
      await writeFile(consumerPath, JSON.stringify(consumer));
      const result = await runNode(
        'scripts/vercel/promote-image.mjs',
        { ...process.env, VERCEL_IMAGE_PIN_FILE: sourcePath },
        [
          '--reference', reference,
          '--provenance-file', 'images/vercel/provenance.json',
          '--source-commit', '4af448f5daba0f9daf02071250f4f5ad389c80df',
          '--publisher-url', publisher.smokeUrl,
          '--consumer-url', consumer.smokeUrl,
          '--publisher-team', 'publisher-team', '--publisher-project', 'publisher-project',
          '--consumer-team', 'consumer-team', '--consumer-project', 'consumer-project',
          '--publisher-team-id', 'publisher-team-id', '--publisher-project-id', 'publisher-project-id',
          '--consumer-team-id', 'consumer-team-id', '--consumer-project-id', 'consumer-project-id',
          '--publisher-evidence', publisherPath, '--consumer-evidence', consumerPath,
        ],
      );
      expect(result.code).toBe(0);
      expect(publisher.snapshots).toEqual([{ id: 'promotion-snapshot', status: 'deleted' }]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('requires executable working-binary probes for image and Sandbox checks', async () => {
    const status = await readFile('images/vercel/status-devbox.sh', 'utf8');
    const smoke = await readFile('scripts/vercel/smoke-sandbox.mjs', 'utf8');
    for (const probe of ['pi --version', 'claude --version', 'codex --version', 'opencode --version', 'gh --version', 'node --version', 'bun --version', 'python --version', 'chromium --version', 'Xvfb -help', 'fluxbox --version', 'x11vnc -version', 'websockify --help']) {
      expect(status).toContain(probe);
      expect(smoke).toContain(probe);
    }
    expect(status).toContain('timeout');
  });

  it('proves every layer in an exact selected manifest uses OCI zstd media types', async () => {
    const manifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: 'sha256:' + 'b'.repeat(64),
        size: 42,
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+zstd',
          digest: 'sha256:' + 'c'.repeat(64),
          size: 100,
        },
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+zstd',
          digest: 'sha256:' + 'd'.repeat(64),
          size: 200,
        },
      ],
    };
    const rawManifest = JSON.stringify(manifest);
    const manifestDigest = `sha256:${createHash('sha256').update(rawManifest).digest('hex')}`;
    const valid = await runNode(
      'scripts/vercel/assert-zstd-manifest.mjs',
      process.env,
      ['--expected-digest', manifestDigest],
      rawManifest,
    );
    expect(valid.code).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      manifestDigest,
      compression: 'zstd',
      layerCount: 2,
      layerMediaTypes: ['application/vnd.oci.image.layer.v1.tar+zstd'],
    });

    manifest.layers[1].mediaType = 'application/vnd.oci.image.layer.v1.tar+gzip';
    const invalid = await runNode(
      'scripts/vercel/assert-zstd-manifest.mjs',
      process.env,
      ['--expected-digest', manifestDigest],
      JSON.stringify(manifest),
    );
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toMatch(/digest|zstd/);

    const mismatchedDigest = await runNode(
      'scripts/vercel/assert-zstd-manifest.mjs',
      process.env,
      ['--expected-digest', digest],
      rawManifest,
    );
    expect(mismatchedDigest.code).not.toBe(0);
    expect(mismatchedDigest.stderr).toContain('does not match');
  });

  it('extracts only a full digest from actual and wrapped candidate tag responses', async () => {
    const actual = await runNode('scripts/vercel/assert-candidate-tag.mjs', process.env, [], JSON.stringify({
      tag: 'sha-source-upstream-base',
      manifestDigest: digest,
      kind: 'index',
    }));
    expect(actual.code).toBe(0);
    expect(actual.stdout.trim()).toBe(digest);

    const wrapped = await runNode('scripts/vercel/assert-candidate-tag.mjs', process.env, [], JSON.stringify({ tag: { manifestDigest: digest } }));
    expect(wrapped.code).toBe(0);
    expect(wrapped.stdout.trim()).toBe(digest);

    const invalid = await runNode('scripts/vercel/assert-candidate-tag.mjs', process.env, [], JSON.stringify({ tag: { manifestDigest: 'sha256:not-a-digest' } }));
    expect(invalid.code).not.toBe(0);
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
        projects: { id: 'consumer-project-id', name: 'consumer-project', accountId: 'consumer-team-id' },
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

  it('redacts arbitrary publisher and consumer token values before upload', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-redaction-secrets-'));
    try {
      const artifact = join(temp, 'error.json');
      const publisherToken = 'publisher-arbitrary-token-123';
      const consumerToken = 'consumer-arbitrary-token-456';
      await writeFile(artifact, JSON.stringify({ error: `${publisherToken} ${consumerToken}`, redacted: false }));
      const result = await runNode('scripts/vercel/redact-artifacts.mjs', {
        ...process.env,
        VERCEL_PUBLISHER_TOKEN: publisherToken,
        VERCEL_CONSUMER_TOKEN: consumerToken,
      }, [artifact]);
      expect(result.code).toBe(0);
      const redacted = await readFile(artifact, 'utf8');
      expect(redacted).not.toContain(publisherToken);
      expect(redacted).not.toContain(consumerToken);
      expect(redacted).toContain('[REDACTED]');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('preserves the byte-exact raw OCI manifest after proving it contains no secret', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-raw-manifest-'));
    try {
      const artifact = join(temp, 'manifest-raw.json');
      const raw = '{"schemaVersion":2,"layers":[]}\n';
      await writeFile(artifact, raw);
      const result = await runNode('scripts/vercel/redact-artifacts.mjs', {
        ...process.env,
        VERCEL_PUBLISHER_TOKEN: 'publisher-secret-token',
      }, [artifact]);
      expect(result.code).toBe(0);
      expect(await readFile(artifact, 'utf8')).toBe(raw);

      await writeFile(artifact, '{"annotation":"publisher-secret-token"}\n');
      const rejected = await runNode('scripts/vercel/redact-artifacts.mjs', {
        ...process.env,
        VERCEL_PUBLISHER_TOKEN: 'publisher-secret-token',
      }, [artifact]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain('raw OCI manifest contained credential material');
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
          discoveryConverged: true,
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
          '--provenance-file', 'images/vercel/provenance.json',
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

  it('re-promotes a second candidate from an already-promoted source pin', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'vercel-promote-repeat-'));
    try {
      const sourcePath = join(temp, 'image.ts');
      await writeFile(sourcePath, await readFile('src/providers/vercel/image.ts', 'utf8'));
      const firstPublisher = join(temp, 'first-publisher.json');
      const firstConsumer = join(temp, 'first-consumer.json');
      const firstPublisherReport = validEvidence('publisher', 'publisher-team-id', 'publisher-project-id') as any;
      const firstConsumerReport = validEvidence('consumer', 'consumer-team-id', 'consumer-project-id') as any;
      firstPublisherReport.smokeUrl = 'https://github.com/gannonh/devbox/actions/runs/200#publisher-smoke';
      firstConsumerReport.smokeUrl = 'https://github.com/gannonh/devbox/actions/runs/201#consumer-smoke';
      await writeFile(firstPublisher, JSON.stringify(firstPublisherReport));
      await writeFile(firstConsumer, JSON.stringify(firstConsumerReport));
      const invoke = async (candidateReference: string, candidateDigest: string, publisherEvidence: string, consumerEvidence: string, sourceCommit: string) => runNode(
        'scripts/vercel/promote-image.mjs',
        { ...process.env, VERCEL_IMAGE_PIN_FILE: sourcePath },
        [
          '--reference', candidateReference,
          '--provenance-file', 'images/vercel/provenance.json',
          '--source-commit', sourceCommit,
          '--publisher-url', 'https://github.com/gannonh/devbox/actions/runs/200#publisher-smoke',
          '--consumer-url', 'https://github.com/gannonh/devbox/actions/runs/201#consumer-smoke',
          '--publisher-team', 'publisher-team', '--publisher-project', 'publisher-project',
          '--consumer-team', 'consumer-team', '--consumer-project', 'consumer-project',
          '--publisher-team-id', 'publisher-team-id', '--publisher-project-id', 'publisher-project-id',
          '--consumer-team-id', 'consumer-team-id', '--consumer-project-id', 'consumer-project-id',
          '--publisher-evidence', publisherEvidence, '--consumer-evidence', consumerEvidence,
        ],
      );
      const first = await invoke(reference, digest, firstPublisher, firstConsumer, '4af448f5daba0f9daf02071250f4f5ad389c80df');
      expect(first.code).toBe(0);

      const secondDigest = 'sha256:' + 'c'.repeat(64);
      const secondReference = `vcr.vercel.com/publisher-team/publisher-project/devbox@${secondDigest}`;
      const secondPublisher = validEvidence('publisher', 'publisher-team-id', 'publisher-project-id') as any;
      const secondConsumer = validEvidence('consumer', 'consumer-team-id', 'consumer-project-id') as any;
      for (const report of [secondPublisher, secondConsumer]) {
        report.imageReference = secondReference;
        report.expectedDigest = secondDigest;
        report.smokeUrl = report.role === 'publisher'
          ? 'https://github.com/gannonh/devbox/actions/runs/200#publisher-smoke'
          : 'https://github.com/gannonh/devbox/actions/runs/201#consumer-smoke';
      }
      const secondPublisherPath = join(temp, 'second-publisher.json');
      const secondConsumerPath = join(temp, 'second-consumer.json');
      await writeFile(secondPublisherPath, JSON.stringify(secondPublisher));
      await writeFile(secondConsumerPath, JSON.stringify(secondConsumer));
      const second = await invoke(secondReference, secondDigest, secondPublisherPath, secondConsumerPath, '5bf448f5daba0f9daf02071250f4f5ad389c80df');
      expect(second.code, second.stderr).toBe(0);
      const promoted = await readFile(sourcePath, 'utf8');
      expect(promoted).toContain(`'${secondReference}'`);
      expect(promoted).toContain("sourceCommit: '5bf448f5daba0f9daf02071250f4f5ad389c80df'");
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
            '--provenance-file', 'images/vercel/provenance.json',
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
            '--provenance-file', 'images/vercel/provenance.json',
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
          '--provenance-file', 'images/vercel/provenance.json',
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
