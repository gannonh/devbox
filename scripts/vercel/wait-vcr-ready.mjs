#!/usr/bin/env node
/** Poll VCR readiness with a hard deadline and actionable terminal failures. */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

const repository = process.env.VERCEL_IMAGE_REPOSITORY;
const tag = process.env.VERCEL_IMAGE_TAG;
const project = process.env.VERCEL_PUBLISHER_PROJECT_ID;
const timeoutMs = Number(process.env.READINESS_TIMEOUT_MS ?? 15 * 60 * 1000);
const pollMs = Number(process.env.READINESS_POLL_MS ?? 15_000);
const evidencePath = process.env.READINESS_EVIDENCE;
if (!repository || !tag || !project) {
  throw new Error('VERCEL_IMAGE_REPOSITORY, VERCEL_IMAGE_TAG, and VERCEL_PUBLISHER_PROJECT_ID are required');
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error('READINESS_TIMEOUT_MS must be a positive finite number');
}
if (!Number.isFinite(pollMs) || pollMs < 0) {
  throw new Error('READINESS_POLL_MS must be a non-negative finite number');
}

const startedAtMs = Date.now();
const deadlineAtMs = startedAtMs + timeoutMs;
const observations = [];
let fixtureIndex = 0;
let fixtureStates;
if (process.env.VCR_READINESS_FIXTURE) {
  try {
    fixtureStates = JSON.parse(process.env.VCR_READINESS_FIXTURE);
    if (!Array.isArray(fixtureStates) || fixtureStates.length === 0) throw new Error('fixture must be a non-empty array');
  } catch (error) {
    throw new Error(`Invalid VCR_READINESS_FIXTURE: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runInspect(deadlineAt) {
  if (fixtureStates) {
    const state = fixtureStates[Math.min(fixtureIndex++, fixtureStates.length - 1)];
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ status: state }), stderr: '', timedOut: false });
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: true });
  }

  return new Promise((resolve) => {
    const child = spawn(
      'vercel',
      ['vcr', 'tag', 'inspect', repository, tag, '--project', project, '--format', 'json'],
      {
        env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      // SIGKILL is deliberate: readiness is a hard deadline, so an ignored
      // SIGTERM or a stuck network request must not keep this job alive. Kill
      // the process group as well so a shell-spawned network helper cannot
      // outlive the inspect child.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, Math.max(1, remainingMs));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve({ ...result, timedOut });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => finish({ code: timedOut ? null : code ?? 1, stdout, stderr }));
    child.on('error', (error) => finish({ code: 1, stdout, stderr: error.message }));
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try { return JSON.parse(text.slice(start)); } catch { return undefined; }
}

function findState(value) {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (/^(status|state|readiness)$/i.test(key) && typeof item === 'string') return item;
    const nested = findState(item);
    if (nested) return nested;
  }
  return undefined;
}

function classify(result) {
  const body = `${result.stdout}\n${result.stderr}`;
  const parsed = parseJson(result.stdout) ?? parseJson(body);
  const state = findState(parsed) ?? findState({ status: body.match(/\b(Ready|Preparing|Unoptimized|image_not_ready)\b/i)?.[1] });
  if (result.code !== 0) {
    if (/401|403|unauthori[sz]ed|forbidden|authentication|token/i.test(body)) {
      return { state: 'authentication_error', detail: 'VCR authentication failed; verify the scoped publisher token and project/team IDs.' };
    }
    if (/image_not_ready/i.test(body)) return { state: 'image_not_ready', detail: 'VCR/Sandbox still reports image_not_ready.' };
    return { state: 'inspect_error', detail: 'VCR readiness inspection failed without exposing command output.' };
  }
  return { state: state ?? 'unknown', detail: 'VCR did not return a recognized readiness state.' };
}

async function saveReport(finalState) {
  if (!evidencePath) return;
  await mkdir(dirname(evidencePath), { recursive: true });
  const finishedAtMs = Date.now();
  await writeFile(evidencePath, `${JSON.stringify({
    repository,
    tag,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    finalState,
    timings: {
      readiness: {
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        deadlineMs: timeoutMs,
        pollMs,
      },
    },
    observations,
  }, null, 2)}\n`);
}

while (Date.now() < deadlineAtMs) {
  const inspectStartedAtMs = Date.now();
  const result = await runInspect(deadlineAtMs);
  const observation = classify(result);
  const inspectFinishedAtMs = Date.now();
  observations.push({
    at: new Date(inspectFinishedAtMs).toISOString(),
    state: result.timedOut ? 'deadline_exceeded' : observation.state,
    durationMs: inspectFinishedAtMs - inspectStartedAtMs,
  });

  if (result.timedOut) {
    await saveReport('deadline_exceeded');
    throw new Error(`VCR readiness deadline exceeded after ${timeoutMs}ms; the inspect process was cancelled`);
  }

  const normalized = String(observation.state).toLowerCase();
  if (normalized === 'ready') {
    await saveReport('Ready');
    console.log('VCR readiness: Ready');
    process.exit(0);
  }
  if (normalized === 'unoptimized') {
    await saveReport('Unoptimized');
    throw new Error('VCR reported Unoptimized: rebuild the candidate for linux/amd64 with Buildx and zstd compression.');
  }
  if (normalized === 'authentication_error') {
    await saveReport('authentication_error');
    throw new Error(observation.detail);
  }
  if (normalized === 'inspect_error') {
    await saveReport('inspect_error');
    throw new Error(observation.detail);
  }

  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) break;
  await sleep(Math.min(pollMs, remainingMs));
}

const last = observations.at(-1)?.state ?? 'unknown';
await saveReport(`timeout:${last}`);
throw new Error(`Timed out after ${timeoutMs}ms waiting for VCR readiness (last state: ${last}). Preparing/image_not_ready require more time; check VCR and the candidate digest.`);
