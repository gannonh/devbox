#!/usr/bin/env node
/**
 * Apply a validated drift report to the agent version manifest.
 *
 * Rewrites images/vercel/agents.json (the source of truth) and the matching
 * version records in provenance.json (observedManagedVmi.versions and
 * runtimePackages) in one deterministic step. The Dockerfile derives its
 * install pins from agents.json at build time, so touching those two files is
 * the complete update. Nothing else in the image content changes, and a
 * report that is not a strict upgrade is refused.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  readAgentManifest,
  validateAgentManifest,
  VERSION_PATTERN,
} from './agent-manifest.mjs';

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Pure update: returns { manifest, provenance } with the declared agent
 * versions bumped and the reviewed provenance version records synced.
 * `updates` is [{ name, latest }]; only strict upgrades are applied.
 */
export function applyAgentUpdates(manifest, provenance, updates) {
  const nextManifest = validateAgentManifest(deepCopy(manifest));
  const nextProvenance = deepCopy(provenance);
  for (const { name, latest } of updates) {
    const agent = nextManifest.agents[name];
    if (!agent) throw new Error(`cannot apply an update for an undeclared agent: ${name}`);
    if (typeof latest !== 'string' || !VERSION_PATTERN.test(latest)) {
      throw new Error(`cannot apply a malformed version for ${name}: ${latest}`);
    }
    if (compareVersions(latest, agent.version) <= 0) {
      throw new Error(`refusing to apply ${name} ${agent.version} -> ${latest}: not a strict upgrade`);
    }
    agent.version = latest;
    if (nextProvenance.observedManagedVmi?.versions) {
      nextProvenance.observedManagedVmi.versions[name] = latest;
    }
    if (nextProvenance.runtimePackages) {
      nextProvenance.runtimePackages[name] = latest;
    }
  }
  return { manifest: nextManifest, provenance: nextProvenance };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (process.argv[1]?.endsWith('/apply-agent-updates.mjs')) {
  await main();
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key?.startsWith('--')) throw new Error(`unexpected argument: ${key ?? ''}`);
    const value = process.argv[index + 1];
    if (value && !value.startsWith('--')) {
      args.set(key.slice(2), value);
      index += 1;
    } else {
      args.set(key.slice(2), true);
    }
  }
  const reportPath = args.get('report');
  if (!reportPath) throw new Error('--report <drift.json> is required');

  let report;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    throw new Error(`drift report is missing or not valid JSON: ${reportPath}`);
  }
  if (!Array.isArray(report.agents) || !Array.isArray(report.updates)) {
    throw new Error('drift report must carry agents and updates arrays');
  }
  const updates = report.updates.map((name) => {
    const entry = report.agents.find((agent) => agent?.name === name);
    if (!entry || typeof entry.latest !== 'string') {
      throw new Error(`drift report names update ${name} without a latest version`);
    }
    return { name, latest: entry.latest };
  });

  const manifest = args.has('agents-file')
    ? validateAgentManifest(JSON.parse(await readFile(args.get('agents-file'), 'utf8')))
    : await readAgentManifest();
  const provenancePath = args.has('provenance-file')
    ? args.get('provenance-file')
    : fileURLToPath(new URL('../../images/vercel/provenance.json', import.meta.url));
  let provenance;
  try {
    provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  } catch {
    throw new Error(`provenance file is missing or not valid JSON: ${provenancePath}`);
  }

  const { manifest: nextManifest, provenance: nextProvenance } = applyAgentUpdates(manifest, provenance, updates);

  if (args.has('dry-run')) {
    console.log(JSON.stringify({ manifest: nextManifest, provenance: nextProvenance }, null, 2));
    process.exit(0);
  }
  const manifestOut = args.has('agents-file')
    ? args.get('agents-file')
    : fileURLToPath(new URL('../../images/vercel/agents.json', import.meta.url));
  const provenanceOut = args.has('provenance-file')
    ? args.get('provenance-file')
    : fileURLToPath(new URL('../../images/vercel/provenance.json', import.meta.url));
  await Promise.all([
    mkdir(dirname(manifestOut), { recursive: true }).then(() => writeFile(manifestOut, serialize(nextManifest), 'utf8')),
    mkdir(dirname(provenanceOut), { recursive: true }).then(() => writeFile(provenanceOut, serialize(nextProvenance), 'utf8')),
  ]);
  for (const { name, latest } of updates) {
    console.log(`applied ${name} ${manifest.agents[name].version} -> ${latest}`);
  }

}
