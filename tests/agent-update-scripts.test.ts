import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildUpdateReport,
  readAgentManifest,
} from '../scripts/vercel/agent-manifest.mjs';

const scriptDir = join(process.cwd(), 'scripts/vercel');
const agentManifestPath = join(process.cwd(), 'images/vercel/agents.json');
const provenancePath0 = join(process.cwd(), 'images/vercel/provenance.json');

// A stub npm executable that answers `npm view <package> version` without
// touching the network, so the detection CLI is exercised end to end.
function makeStubNpm(dir: string, latestByPackage: Record<string, string>): string {
  const binDir = join(dir, 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'npm');
  const cases = Object.entries(latestByPackage)
    .map(([pkg, version]) => `    "${pkg}") echo "${version}" ;;`)
    .join('\n');
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "view" ] && [ "$3" = "version" ]; then\n  case "$2" in\n${cases}\n    *) exit 1 ;;\n  esac\nfi\n`, { mode: 0o755 });
  return binDir;
}

function runCli(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', args, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

// Fixture versions must stay above the checked-in manifest pins; derive them
// from the manifest so the suite survives the daily refresh that bumps it.
function bumpPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

describe('agent update detection and manifest contract CLIs', () => {
  it('detects available agent updates through the real CLI path', async () => {
    const manifest = await readAgentManifest();
    const latestByAgent = {
      pi: bumpPatch(manifest.agents.pi.version),
      claude: bumpPatch(manifest.agents.claude.version),
      codex: bumpPatch(manifest.agents.codex.version),
      opencode: bumpPatch(manifest.agents.opencode.version),
    };
    const fakeLatest = {
      '@earendil-works/pi-coding-agent': latestByAgent.pi,
      '@anthropic-ai/claude-code': latestByAgent.claude,
      '@openai/codex': latestByAgent.codex,
      'opencode-ai': latestByAgent.opencode,
    };
    const work = mkdtempSync(join(tmpdir(), 'agent-update-test-'));
    try {
      const stubPath = makeStubNpm(work, fakeLatest);
      const out = join(work, 'drift.json');
      const result = runCli(
        [join(scriptDir, 'check-agent-updates.mjs'), '--out', out],
        { PATH: `${stubPath}:${process.env.PATH ?? ''}` },
      );
      expect(result.status).toBe(0);
      const report = JSON.parse(readFileSync(out, 'utf8'));
      const expected = buildUpdateReport(manifest, latestByAgent);
      expect(report.agents).toEqual(expected.agents);
      expect(report.updates).toEqual(expected.updates);
      expect(report.summary).toEqual(expected.summary);
      expect(report.filter).toEqual([]);
      // Every declared agent is reported, whatever the drift state.
      expect(report.agents.map((entry: any) => entry.name).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('limits detection to the requested agents', async () => {
    const manifest = await readAgentManifest();
    const fakeLatest = {
      '@earendil-works/pi-coding-agent': bumpPatch(manifest.agents.pi.version),
      '@anthropic-ai/claude-code': bumpPatch(manifest.agents.claude.version),
      '@openai/codex': bumpPatch(manifest.agents.codex.version),
      'opencode-ai': bumpPatch(manifest.agents.opencode.version),
    };
    const work = mkdtempSync(join(tmpdir(), 'agent-update-test-'));
    try {
      const stubPath = makeStubNpm(work, fakeLatest);
      const result = runCli(
        [join(scriptDir, 'check-agent-updates.mjs'), '--agents', 'pi,claude'],
        { PATH: `${stubPath}:${process.env.PATH ?? ''}` },
      );
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.filter).toEqual(['pi', 'claude']);
      expect(report.updates).toEqual(['pi', 'claude']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('rejects an unknown agent filter', async () => {
    const work = mkdtempSync(join(tmpdir(), 'agent-update-test-'));
    try {
      const result = runCli([join(scriptDir, 'check-agent-updates.mjs'), '--agents', 'bogus']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unknown agent in filter');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('passes the manifest contract for the checked-in files', () => {
    const result = runCli([join(scriptDir, 'assert-agent-manifest.mjs')]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent manifest agrees');
  });

  it('rejects a stale provenance file', () => {
    const work = mkdtempSync(join(tmpdir(), 'agent-update-test-'));
    try {
      const provenance = JSON.parse(readFileSync(provenancePath0, 'utf8'));
      provenance.runtimePackages.claude = '2.1.223';
      const stale = join(work, 'provenance.json');
      writeFileSync(stale, JSON.stringify(provenance, null, 2));
      const result = runCli([
        join(scriptDir, 'assert-agent-manifest.mjs'),
        '--provenance-file', stale,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('claude');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('rejects a manifest that was updated without its provenance', () => {
    const work = mkdtempSync(join(tmpdir(), 'agent-update-test-'));
    try {
      const manifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
      manifest.agents.opencode.version = bumpPatch(manifest.agents.opencode.version);
      const bumped = join(work, 'agents.json');
      writeFileSync(bumped, JSON.stringify(manifest, null, 2));
      const result = runCli([
        join(scriptDir, 'assert-agent-manifest.mjs'),
        '--agents-file', bumped,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('opencode');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('apply agent updates', () => {
  it('bumps the declared versions and syncs the reviewed provenance', async () => {
    const { applyAgentUpdates } = await import('../scripts/vercel/apply-agent-updates.mjs');
    const manifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
    const provenance = JSON.parse(readFileSync(provenancePath0, 'utf8'));
    const updates = [
      { name: 'pi', latest: bumpPatch(manifest.agents.pi.version) },
      { name: 'claude', latest: bumpPatch(manifest.agents.claude.version) },
      { name: 'codex', latest: bumpPatch(manifest.agents.codex.version) },
      { name: 'opencode', latest: bumpPatch(manifest.agents.opencode.version) },
    ];
    const { manifest: next, provenance: nextProvenance } = applyAgentUpdates(manifest, provenance, updates);
    for (const { name, latest } of updates) {
      expect(next.agents[name].version).toBe(latest);
      expect(nextProvenance.observedManagedVmi.versions[name]).toBe(latest);
      expect(nextProvenance.runtimePackages[name]).toBe(latest);
    }
    // Everything else is untouched: runtimes, bases, checksums, upstream pins.
    expect(nextProvenance.runtimePackages.npm).toBe(provenance.runtimePackages.npm);
    expect(nextProvenance.node).toEqual(provenance.node);
    expect(nextProvenance.upstream).toEqual(provenance.upstream);
    expect(nextProvenance.chromium).toEqual(provenance.chromium);
    expect(nextProvenance.observedManagedVmi.digest).toBe(provenance.observedManagedVmi.digest);
    // Deterministic serialization for byte-level branch comparisons.
    const again = applyAgentUpdates(manifest, provenance, updates);
    expect(JSON.stringify(next)).toBe(JSON.stringify(again.manifest));
    expect(JSON.stringify(nextProvenance)).toBe(JSON.stringify(again.provenance));
    // The result satisfies the manifest contract.
    const { assertManifestMatchesProvenance } = await import('../scripts/vercel/agent-manifest.mjs');
    expect(() => assertManifestMatchesProvenance(next, nextProvenance)).not.toThrow();
  });

  it('refuses unknown agents and downgrades', async () => {
    const { applyAgentUpdates } = await import('../scripts/vercel/apply-agent-updates.mjs');
    const manifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
    const provenance = JSON.parse(readFileSync(provenancePath0, 'utf8'));
    expect(() => applyAgentUpdates(manifest, provenance, [{ name: 'bogus', latest: '1.0.0' }]))
      .toThrow(/bogus/);
    expect(() => applyAgentUpdates(manifest, provenance, [{ name: 'pi', latest: '0.80.0' }]))
      .toThrow(/0.80.0/);
    expect(() => applyAgentUpdates(manifest, provenance, [{ name: 'pi', latest: 'not-a-version' }]))
      .toThrow(/version/);
  });

  it('refuses updates when provenance lacks the required records', async () => {
    const { applyAgentUpdates } = await import('../scripts/vercel/apply-agent-updates.mjs');
    const manifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
    const provenance = JSON.parse(readFileSync(provenancePath0, 'utf8'));
    delete provenance.runtimePackages;
    expect(() => applyAgentUpdates(manifest, provenance, [{ name: 'pi', latest: bumpPatch(manifest.agents.pi.version) }]))
      .toThrow(/provenance/);
  });

  it('dry-runs without writing the canonical files', async () => {
    const manifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
    const latest = bumpPatch(manifest.agents.pi.version);
    const report = {
      checkedAt: '2026-08-20T00:00:00.000Z',
      agents: [{ name: 'pi', package: '@earendil-works/pi-coding-agent', declared: manifest.agents.pi.version, latest, status: 'update-available' }],
      updates: ['pi'],
      summary: '1 of 4 agents have updates',
    };
    const work = mkdtempSync(join(tmpdir(), 'agent-update-test-'));
    try {
      const reportPath = join(work, 'drift.json');
      writeFileSync(reportPath, JSON.stringify(report));
      const before = readFileSync(agentManifestPath, 'utf8');
      const result = runCli([
        join(scriptDir, 'apply-agent-updates.mjs'),
        '--report', reportPath,
        '--dry-run',
      ]);
      expect(result.status).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.manifest.agents.pi.version).toBe(latest);
      // Canonical files are untouched.
      expect(readFileSync(agentManifestPath, 'utf8')).toBe(before);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('applies a drift report through the real CLI path', async () => {
    const work = mkdtempSync(join(tmpdir(), 'agent-update-test-'));
    try {
      const manifest = JSON.parse(readFileSync(agentManifestPath, 'utf8'));
      const provenance = JSON.parse(readFileSync(provenancePath0, 'utf8'));
      const latest = bumpPatch(manifest.agents.pi.version);
      const report = {
        checkedAt: '2026-08-20T00:00:00.000Z',
        agents: [
          { name: 'pi', package: '@earendil-works/pi-coding-agent', declared: manifest.agents.pi.version, latest, status: 'update-available' },
        ],
        updates: ['pi'],
        summary: '1 of 4 agents have updates',
      };
      const reportPath = join(work, 'drift.json');
      writeFileSync(reportPath, JSON.stringify(report));
      // The CLI edits the files it reads, so copy the checked-in files first.
      const agentsPath = join(work, 'agents.json');
      const provenancePath = join(work, 'provenance.json');
      writeFileSync(agentsPath, readFileSync(agentManifestPath));
      writeFileSync(provenancePath, readFileSync(provenancePath0));
      const result = runCli([
        join(scriptDir, 'apply-agent-updates.mjs'),
        '--report', reportPath,
        '--agents-file', agentsPath,
        '--provenance-file', provenancePath,
      ]);
      expect(result.status).toBe(0);
      const nextManifest = JSON.parse(readFileSync(agentsPath, 'utf8'));
      const nextProvenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
      expect(nextManifest.agents.pi.version).toBe(latest);
      expect(nextProvenance.runtimePackages.pi).toBe(latest);
      expect(nextProvenance.runtimePackages.claude).toBe(provenance.runtimePackages.claude);
      // The CLI round-trips through the contract check.
      const contract = runCli([join(scriptDir, 'assert-agent-manifest.mjs'), '--agents-file', agentsPath, '--provenance-file', provenancePath]);
      expect(contract.status).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});


describe('agent refresh PR body', () => {
  it('renders the promotion artifact with versions, digest, and merge guidance', async () => {
    const { renderAgentPrBody } = await import('../scripts/vercel/render-agent-pr-body.mjs');
    const body = renderAgentPrBody({
      report: {
        checkedAt: '2026-08-20T00:00:00.000Z',
        agents: [
          { name: 'pi', package: '@earendil-works/pi-coding-agent', declared: '0.84.1', latest: '0.84.2', status: 'update-available' },
          { name: 'claude', package: '@anthropic-ai/claude-code', declared: '2.1.224', latest: '2.1.238', status: 'update-available' },
        ],
        updates: ['pi', 'claude'],
        summary: '2 of 4 agents have updates',
      },
      candidateDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      runUrl: 'https://github.com/gannonh/devbox/actions/runs/123',
    });
    expect(body).toContain('pi');
    expect(body).toContain('0.84.1');
    expect(body).toContain('0.84.2');
    expect(body).toContain('2.1.224');
    expect(body).toContain('2.1.238');
    expect(body).toContain('sha256:0123456789abcdef');
    expect(body).toContain('https://github.com/gannonh/devbox/actions/runs/123');
    expect(body).toContain('Merging this pull request promotes');
    expect(body).toContain('nightly');
  });
});
