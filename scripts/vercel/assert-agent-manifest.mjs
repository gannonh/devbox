#!/usr/bin/env node
/**
 * Fail closed unless the agent manifest and the reviewed provenance agree.
 *
 * images/vercel/agents.json is the single source of truth for coding-agent
 * versions; provenance.json records the same versions as reviewed evidence.
 * A partial update -- the manifest bumped without the provenance, or an agent
 * recorded without a declaration -- is a supply-chain defect and exits
 * non-zero with an actionable message. The agent-refresh workflow runs this
 * before building, and the test suite proves both directions of drift are
 * rejected.
 */
import { readFile } from 'node:fs/promises';
import {
  assertManifestMatchesProvenance,
  readAgentManifest,
  validateAgentManifest,
} from './agent-manifest.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!key?.startsWith('--') || !process.argv[index + 1]) throw new Error(`missing value for ${key ?? 'argument'}`);
  args.set(key.slice(2), process.argv[index + 1]);
}

let manifest;
try {
  manifest = args.has('agents-file')
    ? validateAgentManifest(JSON.parse(await readFile(args.get('agents-file'), 'utf8')))
    : await readAgentManifest();
} catch (error) {
  console.error(`[agent-manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const provenancePath = args.get('provenance-file') ?? new URL('../../images/vercel/provenance.json', import.meta.url);
let provenance;
try {
  provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
} catch {
  console.error(`[agent-manifest] provenance file is missing or not valid JSON: ${provenancePath}`);
  process.exit(1);
}

try {
  assertManifestMatchesProvenance(manifest, provenance);
} catch (error) {
  console.error(`[agent-manifest] stale or partially updated image: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(`[agent-manifest] agent manifest agrees with provenance (${Object.keys(manifest.agents).length} agents)`);
