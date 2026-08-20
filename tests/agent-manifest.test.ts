import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  assertManifestMatchesProvenance,
  buildUpdateReport,
  compareVersions,
  readAgentManifest,
  validateAgentManifest,
} from '../scripts/vercel/agent-manifest.mjs';

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

describe('agent version manifest', () => {
  it('declares the four supported coding agents with install sources and an exact-pin policy', async () => {
    const manifest = await readAgentManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.policy).toBe('exact-pin');
    expect(manifest.installSource).toMatch(/^https:\/\//);
    expect(Object.keys(manifest.agents).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
    for (const [name, agent] of Object.entries(manifest.agents)) {
      expect(agent.package, `${name} package`).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/);
      expect(agent.binary, `${name} binary`).toMatch(/^[a-z0-9-]+$/);
      expect(agent.version, `${name} version`).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      expect(agent.versionFlag, `${name} version flag`).toMatch(/^--?[a-z-]+$/);
    }
    // The manifest is the single source of truth: the checked-in provenance
    // must already agree with it (no partial update may ship).
    const provenance = await readJson('images/vercel/provenance.json');
    expect(() => assertManifestMatchesProvenance(manifest, provenance)).not.toThrow();
  });

  it('rejects a manifest that is not a single exact-pin declaration', () => {
    const base = { schemaVersion: 1, policy: 'exact-pin', installSource: 'https://registry.npmjs.org', agents: {} };
    expect(() => validateAgentManifest({ ...base, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validateAgentManifest({ ...base, policy: 'latest' })).toThrow(/policy/);
    expect(() => validateAgentManifest({ ...base, installSource: 'file:///tmp' })).toThrow(/installSource/);
    expect(() => validateAgentManifest({ ...base, agents: { pi: { package: 'pi', binary: 'pi', version: 'latest', versionFlag: '--version' } } }))
      .toThrow(/version/);
    expect(() => validateAgentManifest({ ...base, agents: { 'bad name': { package: 'pi', binary: 'pi', version: '1.0.0', versionFlag: '--version' } } }))
      .toThrow(/agent name/);
    expect(() => validateAgentManifest({ ...base, agents: { pi: { package: 'pi', binary: 'pi', version: '1.0.0', versionFlag: '--version' } }, extra: true }))
      .toThrow(/unknown field/);
  });

  it('rejects stale or partially updated provenance', async () => {
    const manifest = await readAgentManifest();
    const provenance = await readJson('images/vercel/provenance.json');
    const clone = () => JSON.parse(JSON.stringify(provenance)) as Record<string, any>;

    // Version bumped in the manifest but not in the observed inventory.
    const staleObserved = clone();
    staleObserved.observedManagedVmi.versions.claude = '2.1.223';
    expect(() => assertManifestMatchesProvenance(manifest, staleObserved)).toThrow(/claude/);

    // Version bumped in the manifest but not in the runtime package inventory.
    const staleRuntime = clone();
    staleRuntime.runtimePackages.codex = '0.146.0';
    expect(() => assertManifestMatchesProvenance(manifest, staleRuntime)).toThrow(/codex/);

    // Agent added to the manifest but missing from provenance.
    const missingAgent = clone();
    delete missingAgent.runtimePackages.opencode;
    delete missingAgent.observedManagedVmi.versions.opencode;
    expect(() => assertManifestMatchesProvenance(manifest, missingAgent)).toThrow(/opencode/);

    // Agent recorded in provenance but not declared in the manifest: the
    // manifest declares the supported set, so provenance must not drift ahead.
    const extraAgent = clone();
    extraAgent.runtimePackages.extra = '9.9.9';
    extraAgent.observedManagedVmi.versions.extra = '9.9.9';
    expect(() => assertManifestMatchesProvenance(manifest, extraAgent)).toThrow(/extra/);

    // The observed inventory must be validated too: an undeclared version
    // passes only if no runtimePackages entry matches, so reject it directly.
    const extraObserved = clone();
    extraObserved.observedManagedVmi.versions.extra = '9.9.9';
    expect(() => assertManifestMatchesProvenance(manifest, extraObserved)).toThrow(/extra/);
  });

  it('compares exact semver versions', () => {
    expect(compareVersions('0.84.1', '0.84.2')).toBe(-1);
    expect(compareVersions('2.1.224', '2.1.224')).toBe(0);
    expect(compareVersions('1.18.19', '1.18.15')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
  });

  it('orders prerelease identifiers by SemVer rules', () => {
    // Numeric identifiers compare numerically, not lexically.
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(compareVersions('1.0.0-beta.11', '1.0.0-beta.2')).toBe(1);
    // Lexical identifiers compare by ASCII order.
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-rc.1')).toBeLessThan(0);
    // Numeric identifiers sort before non-numeric ones.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
    // A longer identifier list sorts after its prefix.
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1.1')).toBe(-1);
    // Hyphenated identifiers compare as single identifiers.
    expect(compareVersions('1.0.0-rc-1', '1.0.0-rc-2')).toBe(-1);
    // Equal prereleases compare equal.
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
    // The core version still dominates any prerelease.
    expect(compareVersions('1.0.0-alpha', '1.0.1-alpha')).toBe(-1);
  });

  it('classifies each agent against the registry latest', async () => {
    const manifest = await readAgentManifest();
    const report = buildUpdateReport(manifest, {
      pi: '0.84.2',
      claude: '2.1.224',
      codex: '0.147.0',
      opencode: '1.18.15',
    });
    expect(report.updates).toEqual(['pi']);
    const byName = Object.fromEntries(report.agents.map((entry) => [entry.name, entry]));
    expect(byName.pi.status).toBe('update-available');
    expect(byName.pi.declared).toBe('0.84.1');
    expect(byName.pi.latest).toBe('0.84.2');
    expect(byName.claude.status).toBe('up-to-date');
    expect(byName.opencode.status).toBe('up-to-date');
  });

  it('flags a declared version that is newer than the registry latest', async () => {
    const manifest = await readAgentManifest();
    const report = buildUpdateReport(manifest, { pi: '0.80.0', claude: '2.0.0', codex: '0.147.0', opencode: '1.18.15' });
    expect(report.updates).toEqual([]);
    const byName = Object.fromEntries(report.agents.map((entry) => [entry.name, entry]));
    expect(byName.pi.status).toBe('declared-newer');
    expect(byName.claude.status).toBe('declared-newer');
  });

  it('limits updates to the requested agents without hiding the full report', async () => {
    const manifest = await readAgentManifest();
    const report = buildUpdateReport(manifest, {
      pi: '0.84.2',
      claude: '2.1.237',
      codex: '0.147.0',
      opencode: '1.18.15',
    }, { agents: ['pi'] });
    expect(report.agents.map((entry) => entry.name)).toEqual(['pi', 'claude', 'codex', 'opencode']);
    const byName = Object.fromEntries(report.agents.map((entry) => [entry.name, entry]));
    expect(byName.claude.status).toBe('update-available');
    expect(report.updates).toEqual(['pi']);
    expect(report.filter).toEqual(['pi']);
  });
});
