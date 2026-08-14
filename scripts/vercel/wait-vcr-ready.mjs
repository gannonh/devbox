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

const startedAt = Date.now();
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runInspect() {
  if (fixtureStates) {
    const state = fixtureStates[Math.min(fixtureIndex++, fixtureStates.length - 1)];
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ status: state }), stderr: '' });
  }
  return new Promise((resolve) => {
    const child = spawn(
      'vercel',
      ['vcr', 'tag', 'inspect', repository, tag, '--project', project, '--format', 'json'],
      {
        env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }));
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
  await writeFile(evidencePath, `${JSON.stringify({
    repository,
    tag,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    finalState,
    observations,
  }, null, 2)}\n`);
}

while (Date.now() - startedAt < timeoutMs) {
  const result = await runInspect();
  const observation = classify(result);
  observations.push({ at: new Date().toISOString(), state: observation.state });
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
  await sleep(pollMs);
}

const last = observations.at(-1)?.state ?? 'unknown';
await saveReport(`timeout:${last}`);
throw new Error(`Timed out after ${timeoutMs}ms waiting for VCR readiness (last state: ${last}). Preparing/image_not_ready require more time; check VCR and the candidate digest.`);
