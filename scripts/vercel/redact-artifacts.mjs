#!/usr/bin/env node
/**
 * Centralized redaction for Vercel image workflow artifacts.
 *
 * It redacts every credential-shaped environment variable and common bearer /
 * credential forms before an artifact is uploaded.  It is intentionally
 * idempotent so failed steps can run it repeatedly in cleanup.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Field-name redaction targets exact raw sensitive fields only: a generic parent
// key like `fixture` must be recursed (its fingerprint subtree is safe evidence),
// and any *Fingerprint field is a non-reversible hash that must survive.
const sensitiveFieldName = /(TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|PRIVATE_KEY|TEAM_ID|PROJECT_ID|ENV_CONTENT|UAT_|DEVICE_CODE|USER_CODE)/i;
const sensitiveEnvironmentName = /(?:TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|PRIVATE_KEY|TEAM_ID|PROJECT_ID|ENV_CONTENT|UAT_)|^DEVBOX_GITHUB_FIXTURE_/i;
const binaryArtifactExtension = /\.(?:png|webm|mp4)$/i;
const isSensitiveField = (name) => !/Fingerprint/i.test(name) && sensitiveFieldName.test(name);
const secrets = [...new Set(Object.entries(process.env)
  .filter(([name, value]) => sensitiveEnvironmentName.test(name) && typeof value === 'string' && value.length > 0)
  .flatMap(([, value]) => [value, encodeURIComponent(value)]))]
  .sort((left, right) => right.length - left.length);

function redactText(input) {
  let output = input;
  for (const secret of secrets) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/(authorization\s*:\s*Basic\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp_|github_pat_|vcp_|vercel_)[A-Za-z0-9_~-]+/gi, '[REDACTED]')
    // The display access code travels as a pairing query parameter and as the
    // cookie it is exchanged for; neither may reach an evidence artifact.
    .replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:user_)?code=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/(devbox_novnc=)[^;\s"']+/gi, '$1[REDACTED]')
    .replace(/(access code:\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(Vercel device authorization code:\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(VERCEL_(?:TOKEN|OIDC_TOKEN|PASSWORD)\s*[=:]\s*)[^\s,}]+/gi, '$1[REDACTED]');
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        isSensitiveField(name) ? '[REDACTED]' : redactValue(item),
      ]),
    );
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

async function redactFile(path) {
  // Screenshots and optional video evidence contain no structured text to
  // redact. Preserve their bytes for reviewers instead of decoding them as
  // UTF-8 and corrupting the artifact.
  if (binaryArtifactExtension.test(path)) return;
  const input = await readFile(path, 'utf8');
  if (basename(path) === 'manifest-raw.json') {
    JSON.parse(input);
    if (redactText(input) !== input) throw new Error('raw OCI manifest contained credential material');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    if (path.toLowerCase().endsWith('.json')) {
      throw new Error(`cannot redact malformed JSON evidence ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await writeFile(path, redactText(input));
    return;
  }
  const redacted = redactValue(parsed);
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) redacted.redacted = true;
  await writeFile(path, `${JSON.stringify(redacted, null, 2)}\n`);
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
  // Streaming mode: redact line by line so a long docker build stays
  // observable (and tee-able) instead of buffering until EOF. Secrets never
  // contain newlines, so a whole-line buffer cannot split one.
  process.stdin.setEncoding('utf8');
  let pending = '';
  for await (const chunk of process.stdin) {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    process.stdout.write(redactText(lines.join('\n') + '\n'));
  }
  if (pending.length > 0) process.stdout.write(redactText(pending));
} else {
  await Promise.all(targets.map((target) => walk(target)));
}
