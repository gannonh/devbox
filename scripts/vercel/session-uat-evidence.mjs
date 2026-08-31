import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createEvidence({ mode, branch, timeoutMinutes, reportPath, deadlineToleranceMs, environment = process.env }) {
  const secrets = collectSecrets(environment);
  const report = {
    schemaVersion: 1,
    redacted: false,
    mode,
    branchFingerprint: fingerprint(branch),
    timeoutMinutes,
    checks: [],
    preflight: { attempted: false, exitCode: null, accepted: false },
    cleanup: { attempted: false, exitCode: null, accepted: false },
  };
  const redact = (value) => redactValue(value, secrets);
  const redactTail = (value) => redactTailValue(value, secrets);
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail: redact(detail) });
    if (!ok) throw new Error(`${name} failed`);
  };
  return {
    report,
    redact,
    redactTail,
    check,
    markerFor,
    sameDeadline: (expected, actual) => sameDeadline(expected, actual, deadlineToleranceMs),
    writeReport: async () => {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

export function collectSecrets(environment = process.env) {
  return [...new Set(Object.entries(environment)
    .filter(([name, value]) => /TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|TEAM_ID|PROJECT_ID|PRIVATE_KEY|ENV_CONTENT|^DEVBOX_GITHUB_FIXTURE_/i.test(name) && value)
    .map(([, value]) => value))]
    .sort((left, right) => right.length - left.length);
}

export function redactValue(value, secrets) {
  return sanitizeValue(value, secrets).slice(0, 300);
}

export function redactTailValue(value, secrets) {
  return sanitizeValue(value, secrets).slice(-1200);
}

function sanitizeValue(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    result = result.split(secret).join('[REDACTED]');
    result = result.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return result
    .replace(/(authorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp_|github_pat_|vcp_|vercel_)[A-Za-z0-9_~-]+/gi, '[REDACTED]')
    .replace(/([?&]token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(devbox_novnc=)[^;\s"']+/gi, '$1[REDACTED]')
    .replace(/(access code:\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(VERCEL_(?:TOKEN|OIDC_TOKEN|PASSWORD)\s*[=:]\s*)[^\s,}]+/gi, '$1[REDACTED]');
}

export function sameDeadline(expected, actual, toleranceMs) {
  const expectedMs = Date.parse(expected ?? '');
  const actualMs = Date.parse(actual ?? '');
  return Number.isFinite(expectedMs)
    && Number.isFinite(actualMs)
    && Math.abs(expectedMs - actualMs) <= toleranceMs;
}

export function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function markerFor(label) {
  return `DEVBOX_UAT_${label}_${randomBytes(8).toString('hex')}`;
}

export function required(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function positiveInteger(name, fallback, environment = process.env) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function signalCode(signal) {
  return signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 1;
}
