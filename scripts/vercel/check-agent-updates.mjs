#!/usr/bin/env node
/**
 * Detect available coding-agent updates against the declared manifest.
 *
 * Reads images/vercel/agents.json, resolves the registry's current latest
 * version for every declared agent (npm view, public registry, no
 * credentials), and prints a JSON drift report. The report drives the
 * agent-refresh workflow: no updates means the run ends green with nothing
 * changed; updates feed the candidate build and the promotion PR.
 *
 * A registry failure fails closed: the current pin is never touched and the
 * error names the unreachable source.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  buildUpdateReport,
  readAgentManifest,
  VERSION_PATTERN,
} from './agent-manifest.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!key?.startsWith('--') || !process.argv[index + 1]) throw new Error(`missing value for ${key ?? 'argument'}`);
  args.set(key.slice(2), process.argv[index + 1]);
}

function resolveLatestVersion(packageName, installSource) {
  let output;
  try {
    output = execFileSync('npm', ['view', packageName, 'version', '--registry', installSource], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`could not resolve the latest ${packageName} version from ${installSource}`);
  }
  const latest = output.trim().split(/\s+/).at(-1) ?? '';
  if (!VERSION_PATTERN.test(latest)) {
    throw new Error(`registry returned a malformed latest version for ${packageName}: ${latest}`);
  }
  return latest;
}

const manifest = await readAgentManifest();
const filter = (args.get('agents') ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const latestByAgent = {};
for (const [name, agent] of Object.entries(manifest.agents)) {
  latestByAgent[name] = resolveLatestVersion(agent.package, manifest.installSource);
}
const report = buildUpdateReport(manifest, latestByAgent, { agents: filter });
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const outPath = args.get('out');
if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, serialized, 'utf8');
  console.log(`wrote agent update report (${report.updates.length} updates) to ${outPath}`);
} else {
  process.stdout.write(serialized);
}
