#!/usr/bin/env node
/** Update the sole checked-in Vercel image pin after validated smoke evidence. */
import { readFile, writeFile } from 'node:fs/promises';
import {
  parseFullyQualifiedVcrReference,
  REQUIRED_SMOKE_CHECKS,
  REQUIRED_SMOKE_TIMINGS,
} from './smoke-contract.mjs';

const sourcePath = process.env.VERCEL_IMAGE_PIN_FILE ?? 'src/providers/vercel/image.ts';
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!key?.startsWith('--') || !process.argv[index + 1]) throw new Error(`missing value for ${key ?? 'argument'}`);
  args.set(key.slice(2), process.argv[index + 1]);
}
const required = [
  'reference', 'base-reference', 'source-commit', 'publisher-url', 'consumer-url',
  'publisher-team', 'publisher-project', 'consumer-team', 'consumer-project',
  'publisher-team-id', 'publisher-project-id', 'consumer-team-id', 'consumer-project-id',
  'publisher-evidence', 'consumer-evidence',
];
for (const key of required) {
  if (!args.get(key)) throw new Error(`--${key} is required`);
}

const reference = args.get('reference');
const baseReference = args.get('base-reference');
const imageInfo = parseFullyQualifiedVcrReference(reference);
if (!/^vcr\.vercel\.com\/vercel\/sandbox\/universal@sha256:[a-f0-9]{64}$/.test(baseReference)) {
  throw new Error('base reference must be a digest-pinned Universal VCR reference');
}
if (!/^sha256:[a-f0-9]{64}$/.test(baseReference.slice(baseReference.indexOf('@') + 1))) {
  throw new Error('base reference must contain a full sha256 digest');
}
if (!/^[a-f0-9]{40}$/.test(args.get('source-commit'))) {
  throw new Error('source commit must be a full commit SHA');
}
const slugPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
for (const key of ['publisher-team', 'publisher-project', 'consumer-team', 'consumer-project']) {
  if (!slugPattern.test(args.get(key))) throw new Error(`--${key} must be a Vercel slug`);
}
if (args.get('publisher-team') !== imageInfo.team || args.get('publisher-project') !== imageInfo.project) {
  throw new Error('publisher scope must match the candidate image reference');
}
for (const key of ['publisher-url', 'consumer-url']) {
  try {
    if (new URL(args.get(key)).protocol !== 'https:') throw new Error('not https');
  } catch {
    throw new Error(`--${key} must be an HTTPS URL`);
  }
}
if (args.get('publisher-team') === args.get('consumer-team') && args.get('publisher-project') === args.get('consumer-project')) {
  throw new Error('publisher and consumer scopes must be independent');
}
if (args.get('publisher-team-id') === args.get('consumer-team-id') && args.get('publisher-project-id') === args.get('consumer-project-id')) {
  throw new Error('publisher and consumer scope IDs must be independent');
}

async function readEvidence(path, role, expectedScope, expectedSmokeUrl) {
  let evidence;
  try {
    evidence = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${role} smoke evidence is not valid JSON`);
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.redacted !== true) {
    throw new Error(`${role} smoke evidence must be redacted before promotion`);
  }
  if (evidence.role !== role) throw new Error(`${role} smoke evidence role does not match`);
  if (evidence.failed === true) throw new Error(`${role} smoke evidence is marked failed`);
  if (evidence.smokeUrl !== expectedSmokeUrl) throw new Error(`${role} smoke evidence URL does not match the promoted evidence URL`);
  if (evidence.imageReference !== reference || evidence.expectedDigest !== imageInfo.digest) {
    throw new Error(`${role} smoke evidence does not prove the exact candidate digest`);
  }
  if (
    typeof evidence.startedAt !== 'string' ||
    typeof evidence.finishedAt !== 'string' ||
    !Number.isFinite(evidence.durationMs) ||
    evidence.durationMs < 0
  ) {
    throw new Error(`${role} smoke evidence is missing aggregate timing fields`);
  }
  if (!evidence.scope || evidence.scope.teamId !== expectedScope.teamId || evidence.scope.projectId !== expectedScope.projectId) {
    throw new Error(`${role} smoke evidence scope does not match the reviewed project`);
  }
  const checks = new Map(Array.isArray(evidence.checks) ? evidence.checks.map((check) => [check.name, check]) : []);
  if (
    evidence.requiredChecksComplete !== true ||
    checks.size !== (Array.isArray(evidence.checks) ? evidence.checks.length : 0) ||
    !REQUIRED_SMOKE_CHECKS.every((name) => checks.get(name)?.ok === true)
  ) {
    throw new Error(`${role} smoke evidence is missing a required named check or contains a duplicate/failed check`);
  }
  const timings = evidence.timings;
  if (!timings || !REQUIRED_SMOKE_TIMINGS.every((name) => {
    const timing = timings[name];
    return timing && timing.outcome === 'passed' && typeof timing.startedAt === 'string' &&
      typeof timing.finishedAt === 'string' && Number.isFinite(timing.durationMs) && timing.durationMs >= 0;
  })) {
    throw new Error(`${role} smoke evidence is missing a required successful timing stage`);
  }
  const observations = evidence.sessionStates;
  const finalStates = observations?.at(-1)?.states;
  if (
    !Array.isArray(observations) || observations.length === 0 ||
    observations.some((observation) => !Array.isArray(observation.states) || observation.states.some((session) => typeof session.id !== 'string' || typeof session.status !== 'string')) ||
    !Array.isArray(finalStates) || finalStates.length === 0 ||
    finalStates.some((session) => !['stopped', 'aborted'].includes(session.status))
  ) {
    throw new Error(`${role} smoke evidence does not prove terminal stopped/aborted session states`);
  }
  if (
    typeof evidence.terminalSession?.commandId !== 'string' ||
    evidence.terminalSession?.state !== 'completed' ||
    evidence.terminalSession?.exitCode !== 0
  ) {
    throw new Error(`${role} smoke evidence does not prove a successful terminal command`);
  }
  const cleanup = evidence.cleanup;
  if (
    cleanup?.stopped !== true ||
    cleanup.deleted !== true ||
    cleanup.deletionVerified !== true ||
    cleanup.snapshotsCleaned !== true ||
    cleanup.finalSessionStatesTerminal !== true ||
    cleanup.noRunningSessionAfterDelete !== true ||
    !Array.isArray(cleanup.residualNonDeletedSnapshots) ||
    cleanup.residualNonDeletedSnapshots.length > 0 ||
    (Array.isArray(cleanup.errors) && cleanup.errors.length > 0)
  ) {
    throw new Error(`${role} smoke evidence does not prove Sandbox and snapshot cleanup`);
  }
  if (typeof evidence.sandboxName !== 'string' || typeof evidence.noVncUrl !== 'string') {
    throw new Error(`${role} smoke evidence is missing Sandbox identity fields`);
  }
  if (!Array.isArray(evidence.snapshots) || evidence.snapshots.some((snapshot) => typeof snapshot.id !== 'string' || snapshot.status !== 'deleted')) {
    throw new Error(`${role} smoke evidence contains an undeleted or unidentified snapshot`);
  }
  return evidence;
}

const publisherEvidence = await readEvidence(args.get('publisher-evidence'), 'publisher', {
  teamId: args.get('publisher-team-id'),
  projectId: args.get('publisher-project-id'),
}, args.get('publisher-url'));
const consumerEvidence = await readEvidence(args.get('consumer-evidence'), 'consumer', {
  teamId: args.get('consumer-team-id'),
  projectId: args.get('consumer-project-id'),
}, args.get('consumer-url'));
if (publisherEvidence.scope.teamId === consumerEvidence.scope.teamId && publisherEvidence.scope.projectId === consumerEvidence.scope.projectId) {
  throw new Error('publisher and consumer evidence prove the same project scope');
}

let source = await readFile(sourcePath, 'utf8');
function replaceStringField(field, value) {
  const pattern = new RegExp(`(^\\s*${field}:\\s*)'[^']*'(,?)$`, 'm');
  const next = source.replace(pattern, (_match, prefix, suffix) => `${prefix}'${value}'${suffix}`);
  if (next === source) throw new Error(`could not update ${field} in ${sourcePath}`);
  source = next;
}

function replaceScopeField(field, team, project) {
  const pattern = new RegExp(
    `(^\\s*${field}:\\s*\\{\\s*team:\\s*)'[^']*'(,\\s*project:\\s*)'[^']*'(\\s*\\},?)$`,
    'm',
  );
  const next = source.replace(pattern, (_match, prefix, separator, suffix) => `${prefix}'${team}'${separator}'${project}'${suffix}`);
  if (next === source) throw new Error(`could not update ${field} in ${sourcePath}`);
  source = next;
}

source = source.replace(
  /export const VERCEL_IMAGE_REFERENCE =\n\s*'[^']+';/m,
  `export const VERCEL_IMAGE_REFERENCE =\n  '${reference}';`,
);
if (!source.includes(`'${reference}'`)) throw new Error('could not update VERCEL_IMAGE_REFERENCE');
replaceStringField('baseReference', baseReference);
replaceStringField('baseDigest', baseReference.slice(baseReference.indexOf('@') + 1));
replaceStringField('sourceCommit', args.get('source-commit'));
replaceStringField('publisherSmokeUrl', args.get('publisher-url'));
replaceStringField('consumerSmokeUrl', args.get('consumer-url'));
replaceScopeField('publisher', args.get('publisher-team'), args.get('publisher-project'));
replaceScopeField('consumer', args.get('consumer-team'), args.get('consumer-project'));
if (!source.includes("publisherSmokeStatus: 'pending'")) throw new Error('publisher smoke status field is missing');
if (!source.includes("consumerSmokeStatus: 'pending'")) throw new Error('consumer smoke status field is missing');
if (!source.includes('crossProjectVerified: false')) throw new Error('cross-project verification field is missing');
source = source.replace("publisherSmokeStatus: 'pending'", "publisherSmokeStatus: 'passed'");
source = source.replace("consumerSmokeStatus: 'pending'", "consumerSmokeStatus: 'passed'");
source = source.replace('crossProjectVerified: false', 'crossProjectVerified: true');
await writeFile(sourcePath, source);
console.log(`prepared promotion pin for ${reference}`);
