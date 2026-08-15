#!/usr/bin/env node
/**
 * Centralized redaction for Vercel image workflow artifacts.
 *
 * It redacts every credential-shaped environment variable and common bearer /
 * Basic Auth forms before an artifact is uploaded.  It is intentionally
 * idempotent so failed steps can run it repeatedly in cleanup.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const secretNames = /(TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|PRIVATE_KEY)/i;
const secrets = Object.entries(process.env)
  .filter(([name, value]) => secretNames.test(name) && value && value.length >= 4)
  .map(([, value]) => value);

function redactText(input) {
  let output = input;
  for (const secret of secrets) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/(authorization\s*:\s*Basic\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp_|github_pat_|vcp_|vercel_)[A-Za-z0-9_~-]+/gi, '[REDACTED]')
    .replace(/(VERCEL_(?:TOKEN|OIDC_TOKEN|PASSWORD)\s*[=:]\s*)[^\s,}]+/gi, '$1[REDACTED]');
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        secretNames.test(name) ? '[REDACTED]' : redactValue(item),
      ]),
    );
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

async function redactFile(path) {
  const input = await readFile(path, 'utf8');
  if (basename(path) === 'manifest-raw.json') {
    JSON.parse(input);
    if (redactText(input) !== input) throw new Error('raw OCI manifest contained credential material');
    return;
  }
  try {
    const parsed = JSON.parse(input);
    const redacted = redactValue(parsed);
    if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) redacted.redacted = true;
    await writeFile(path, `${JSON.stringify(redacted, null, 2)}\n`);
  } catch {
    await writeFile(path, redactText(input));
  }
}

async function walk(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await walk(join(path, entry));
    return;
  }
  await redactFile(path);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(redactText(input));
} else {
  await Promise.all(targets.map((target) => walk(target)));
}
