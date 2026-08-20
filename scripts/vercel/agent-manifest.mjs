#!/usr/bin/env node
/**
 * Shared contract for the coding-agent version manifest.
 *
 * images/vercel/agents.json is the single source of truth for the supported
 * coding agents: their npm install sources, binaries, exact pinned versions,
 * and version-probe flags. The Dockerfile derives its install pins from it at
 * build time, provenance.json records the same versions as reviewed evidence,
 * and the smoke gate verifies the installed binaries against it. Every check
 * in this file fails closed on drift so a stale or partially updated image is
 * rejected instead of shipped.
 */
import { readFile } from 'node:fs/promises';

export const AGENT_MANIFEST_PATH = new URL('../../images/vercel/agents.json', import.meta.url);
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const NPM_PACKAGE_PATTERN = /^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/;
export const BINARY_PATTERN = /^[a-z0-9-]+$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const FLAG_PATTERN = /^--?[a-z-]+$/;

/**
 * Loose exact-semver compare for the version policy. These packages publish
 * stable x.y.z releases; prerelease segments sort below the same release.
 */
export function compareVersions(a, b) {
  const segment = (value) => value.split('-')[0].split('.').map(Number);
  const aSegments = segment(a);
  const bSegments = segment(b);
  for (let index = 0; index < 3; index += 1) {
    if (aSegments[index] !== bSegments[index]) return aSegments[index] < bSegments[index] ? -1 : 1;
  }
  const aPre = a.includes('-');
  const bPre = b.includes('-');
  if (aPre !== bPre) return aPre ? -1 : 1;
  return 0;
}

export function validateAgentManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent manifest must be a JSON object');
  }
  if (value.schemaVersion !== 1) throw new Error('agent manifest schemaVersion must be 1');
  if (value.policy !== 'exact-pin') {
    throw new Error('agent manifest policy must be exact-pin (unpinned installs are forbidden)');
  }
  if (typeof value.installSource !== 'string' || !/^https:\/\//.test(value.installSource)) {
    throw new Error('agent manifest installSource must be an HTTPS registry');
  }
  const allowedFields = new Set(['schemaVersion', 'policy', 'installSource', 'agents']);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) throw new Error(`agent manifest has an unknown field: ${field}`);
  }
  const agents = value.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents) || Object.keys(agents).length === 0) {
    throw new Error('agent manifest must declare at least one agent');
  }
  const agentFields = new Set(['package', 'binary', 'version', 'versionFlag']);
  for (const [name, agent] of Object.entries(agents)) {
    if (!AGENT_NAME_PATTERN.test(name)) throw new Error(`agent name is malformed: ${name}`);
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
      throw new Error(`agent ${name} declaration must be an object`);
    }
    for (const field of Object.keys(agent)) {
      if (!agentFields.has(field)) throw new Error(`agent ${name} has an unknown field: ${field}`);
    }
    if (typeof agent.package !== 'string' || !NPM_PACKAGE_PATTERN.test(agent.package)) {
      throw new Error(`agent ${name} package name is malformed`);
    }
    if (typeof agent.binary !== 'string' || !BINARY_PATTERN.test(agent.binary)) {
      throw new Error(`agent ${name} binary name is malformed`);
    }
    if (typeof agent.version !== 'string' || !VERSION_PATTERN.test(agent.version)) {
      throw new Error(`agent ${name} version must be an exact pinned semver`);
    }
    if (typeof agent.versionFlag !== 'string' || !FLAG_PATTERN.test(agent.versionFlag)) {
      throw new Error(`agent ${name} versionFlag must be a short flag`);
    }
  }
  return value;
}

export async function readAgentManifest() {
  let raw;
  try {
    raw = await readFile(AGENT_MANIFEST_PATH, 'utf8');
  } catch {
    throw new Error(`agent manifest is missing: ${AGENT_MANIFEST_PATH}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('agent manifest is not valid JSON');
  }
  return validateAgentManifest(manifest);
}

/**
 * Fail closed unless the reviewed provenance records exactly the declared
 * agent versions. A partial update (manifest bumped, provenance stale, or an
 * agent recorded without a declaration) is a supply-chain defect.
 */
export function assertManifestMatchesProvenance(manifest, provenance) {
  const observed = provenance?.observedManagedVmi?.versions;
  const runtime = provenance?.runtimePackages;
  if (!observed || typeof observed !== 'object' || !runtime || typeof runtime !== 'object') {
    throw new Error('provenance is missing observedManagedVmi.versions or runtimePackages');
  }
  for (const [name, agent] of Object.entries(manifest.agents)) {
    if (observed[name] !== agent.version) {
      throw new Error(`provenance observedManagedVmi.versions.${name} is ${observed[name] ?? 'missing'}, expected ${agent.version}`);
    }
    if (runtime[name] !== agent.version) {
      throw new Error(`provenance runtimePackages.${name} is ${runtime[name] ?? 'missing'}, expected ${agent.version}`);
    }
  }
  // provenance.runtimePackages also records non-agent runtimes; anything else
  // is an agent that must be declared here.
  const nonAgentRuntimes = new Set(['npm', 'pnpm', 'python', 'pip', 'uv', 'gh']);
  for (const name of Object.keys(runtime)) {
    if (name in manifest.agents || nonAgentRuntimes.has(name)) continue;
    throw new Error(`provenance runtimePackages.${name} is not a declared agent or runtime`);
  }
  return manifest;
}

/**
 * Compare each declared agent against the registry's current latest version.
 * `latestByAgent` maps agent names to the versions the registry reported.
 * The optional filter (manual dispatch) limits which agents count as updates
 * but never hides the full report.
 */
export function buildUpdateReport(manifest, latestByAgent, { agents: filter } = {}) {
  const requested = new Set(filter ?? []);
  for (const name of requested) {
    if (!(name in manifest.agents)) throw new Error(`unknown agent in filter: ${name}`);
  }
  const agents = [];
  const updates = [];
  for (const [name, agent] of Object.entries(manifest.agents)) {
    const latest = latestByAgent[name];
    if (typeof latest !== 'string' || !VERSION_PATTERN.test(latest)) {
      throw new Error(`registry returned a malformed latest version for ${name}: ${latest}`);
    }
    const status = compareVersions(agent.version, latest) === 0
      ? 'up-to-date'
      : compareVersions(agent.version, latest) > 0
        ? 'declared-newer'
        : 'update-available';
    const entry = { name, package: agent.package, declared: agent.version, latest, status };
    agents.push(entry);
    if (status === 'update-available' && (requested.size === 0 || requested.has(name))) updates.push(name);
  }
  return {
    schemaVersion: 1,
    policy: manifest.policy,
    installSource: manifest.installSource,
    checkedAt: new Date().toISOString(),
    agents,
    updates,
    filter: filter ? [...filter] : [],
    summary: `${updates.length} of ${agents.length} agents have updates`,
  };
}

if (process.argv[1] && process.argv[1].endsWith('/agent-manifest.mjs')) {
  const manifest = await readAgentManifest();
  console.log(JSON.stringify(manifest, null, 2));
}
