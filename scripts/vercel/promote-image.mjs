#!/usr/bin/env node
/** Update the sole checked-in Vercel image pin after validated smoke evidence. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  parseFullyQualifiedVcrReference,
  REQUIRED_SMOKE_CHECKS,
  REQUIRED_SMOKE_TIMINGS,
} from './smoke-contract.mjs';
import { isStrictEvidenceUrl } from '../../src/providers/vercel/strict-url.js';

const sourcePath = process.env.VERCEL_IMAGE_PIN_FILE ?? 'src/providers/vercel/image.ts';
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!key?.startsWith('--') || !process.argv[index + 1]) throw new Error(`missing value for ${key ?? 'argument'}`);
  args.set(key.slice(2), process.argv[index + 1]);
}
const required = [
  'reference', 'provenance-file', 'source-commit', 'publisher-url', 'consumer-url',
  'publisher-team', 'publisher-project', 'consumer-team', 'consumer-project',
  'publisher-team-id', 'publisher-project-id', 'consumer-team-id', 'consumer-project-id',
  'publisher-evidence', 'consumer-evidence',
];
for (const key of required) {
  if (!args.get(key)) throw new Error(`--${key} is required`);
}

const reference = args.get('reference');
const provenancePath = args.get('provenance-file');
const imageInfo = parseFullyQualifiedVcrReference(reference);
if (!/^[a-f0-9]{40}$/.test(args.get('source-commit'))) {
  throw new Error('source commit must be a full commit SHA');
}
const slugPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
for (const key of ['publisher-team', 'publisher-project', 'consumer-team', 'consumer-project']) {
  if (!slugPattern.test(args.get(key))) throw new Error(`--${key} must be a Vercel slug`);
}

const MAX_EVIDENCE_DURATION_MS = 24 * 60 * 60 * 1000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validIsoTimestamp(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  } catch {
    return false;
  }
}

function validTiming(timing) {
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return false;
  if (!validIsoTimestamp(timing.startedAt) || !validIsoTimestamp(timing.finishedAt)) return false;
  const startedMs = Date.parse(timing.startedAt);
  const finishedMs = Date.parse(timing.finishedAt);
  return Number.isSafeInteger(timing.startedEpochMs) &&
    Number.isSafeInteger(timing.finishedEpochMs) &&
    timing.finishedEpochMs >= timing.startedEpochMs &&
    finishedMs >= startedMs &&
    Number.isSafeInteger(timing.durationMs) &&
    timing.durationMs >= 0 &&
    timing.durationMs <= MAX_EVIDENCE_DURATION_MS &&
    Math.abs(timing.durationMs - (finishedMs - startedMs)) <= 1_000 &&
    Math.abs(timing.durationMs - (timing.finishedEpochMs - timing.startedEpochMs)) <= 1_000;
}
let provenanceRaw;
let provenance;
try {
  provenanceRaw = await readFile(provenancePath, 'utf8');
  provenance = JSON.parse(provenanceRaw);
} catch {
  throw new Error('provenance file must be valid JSON');
}
if (
  provenance.schemaVersion !== 1 ||
  provenance.platform !== 'linux/amd64' ||
  !/^https:\/\/github\.com\/vercel\/sandbox$/.test(provenance.upstream?.repository ?? '') ||
  !/^[a-f0-9]{40}$/.test(provenance.upstream?.commit ?? '') ||
  !/^[a-f0-9]{64}$/.test(provenance.upstream?.ubuntuDockerfileSha256 ?? '') ||
  !/^[a-f0-9]{64}$/.test(provenance.upstream?.universalDockerfileSha256 ?? '') ||
  !/^sha256:[a-f0-9]{64}$/.test(provenance.observedManagedVmi?.digest ?? '') ||
  !/^docker\.io\/library\/ubuntu:26\.04@sha256:[a-f0-9]{64}$/.test(provenance.baseImages?.ubuntu ?? '') ||
  !/^docker\.io\/oven\/bun:1\.3\.14@sha256:[a-f0-9]{64}$/.test(provenance.baseImages?.bun ?? '') ||
  !/^24\.19\.0$/.test(provenance.node?.version ?? '') ||
  provenance.node?.platform !== 'linux-x64' ||
  !/^[a-f0-9]{64}$/.test(provenance.node?.sha256 ?? '') ||
  !/^\d{8}T\d{6}Z$/.test(provenance.aptSnapshot ?? '')
) {
  throw new Error('provenance file does not match the audited Universal mirror contract');
}
const provenanceDigest = `sha256:${createHash('sha256').update(provenanceRaw).digest('hex')}`;

if (args.get('publisher-team') !== imageInfo.team || args.get('publisher-project') !== imageInfo.project) {
  throw new Error('publisher scope must match the candidate image reference');
}
for (const key of ['publisher-url', 'consumer-url']) {
  if (!isStrictEvidenceUrl(args.get(key))) throw new Error(`--${key} must be an HTTPS URL without credentials or query secrets`);
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
  if (!validTiming({
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    startedEpochMs: Date.parse(evidence.startedAt),
    finishedEpochMs: Date.parse(evidence.finishedAt),
    durationMs: evidence.durationMs,
  })) {
    throw new Error(`${role} smoke evidence has invalid aggregate timing fields`);
  }
  if (
    !evidence.scope || typeof evidence.scope !== 'object' || Array.isArray(evidence.scope) ||
    !nonEmptyString(evidence.scope.teamId) || !nonEmptyString(evidence.scope.projectId) ||
    evidence.scope.teamId !== expectedScope.teamId || evidence.scope.projectId !== expectedScope.projectId
  ) {
    throw new Error(`${role} smoke evidence scope does not match the reviewed project`);
  }
  if (
    !Array.isArray(evidence.checks) ||
    evidence.checks.some((check) => !check || typeof check !== 'object' || !nonEmptyString(check.name) || typeof check.ok !== 'boolean')
  ) {
    throw new Error(`${role} smoke evidence contains a malformed named check`);
  }
  const checks = new Map(evidence.checks.map((check) => [check.name, check]));
  if (
    evidence.requiredChecksComplete !== true ||
    checks.size !== evidence.checks.length ||
    !REQUIRED_SMOKE_CHECKS.every((name) => checks.get(name)?.ok === true)
  ) {
    throw new Error(`${role} smoke evidence is missing a required named check or contains a duplicate/failed check`);
  }
  const timings = evidence.timings;
  if (!timings || typeof timings !== 'object' || Array.isArray(timings) || !REQUIRED_SMOKE_TIMINGS.every((name) => {
    const timing = timings[name];
    return timing && timing.outcome === 'passed' && validTiming(timing);
  })) {
    throw new Error(`${role} smoke evidence is missing a required successful timing stage`);
  }
  const observations = evidence.sessionStates;
  const finalObservation = observations?.at(-1);
  const finalStates = finalObservation?.states;
  const deletionMissing = finalObservation?.phase === 'after-delete-missing' && Array.isArray(finalStates) && finalStates.length === 0;
  const terminalProofStates = deletionMissing
    ? observations?.slice().reverse().find((observation) =>
      Array.isArray(observation?.states) && observation.states.length > 0 &&
      observation.states.every((session) => ['stopped', 'aborted'].includes(session.status)),
    )?.states
    : finalStates;
  if (
    !Array.isArray(observations) || observations.length === 0 ||
    observations.some((observation) =>
      !observation || typeof observation !== 'object' || !nonEmptyString(observation.phase) ||
      !Array.isArray(observation.states) ||
      observation.states.some((session) => !session || !nonEmptyString(session.id) || !nonEmptyString(session.status))
    ) ||
    !Array.isArray(terminalProofStates) || terminalProofStates.length === 0 ||
    terminalProofStates.some((session) => !['stopped', 'aborted'].includes(session.status))
  ) {
    throw new Error(`${role} smoke evidence does not prove terminal stopped/aborted session states`);
  }
  if (
    !evidence.terminalSession || typeof evidence.terminalSession !== 'object' ||
    !nonEmptyString(evidence.terminalSession.commandId) ||
    evidence.terminalSession.state !== 'completed' ||
    evidence.terminalSession.exitCode !== 0
  ) {
    throw new Error(`${role} smoke evidence does not prove a successful terminal command`);
  }
  const cleanup = evidence.cleanup;
  if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
    throw new Error(`${role} smoke evidence is missing cleanup fields`);
  }
  if (
    cleanup.stopped !== true ||
    cleanup.deleted !== true ||
    cleanup.deletionVerified !== true ||
    cleanup.discoveryConverged !== true ||
    cleanup.snapshotsCleaned !== true ||
    cleanup.finalSessionStatesTerminal !== true ||
    cleanup.noRunningSessionAfterDelete !== true ||
    !Array.isArray(cleanup.residualNonDeletedSnapshots) ||
    cleanup.residualNonDeletedSnapshots.some((snapshot) => !snapshot || !nonEmptyString(snapshot.id) || !nonEmptyString(snapshot.status)) ||
    cleanup.residualNonDeletedSnapshots.length > 0 ||
    (cleanup.errors !== undefined && (!Array.isArray(cleanup.errors) || cleanup.errors.some((error) => !nonEmptyString(error)))) ||
    (Array.isArray(cleanup.errors) && cleanup.errors.length > 0)
  ) {
    throw new Error(`${role} smoke evidence does not prove Sandbox and snapshot cleanup`);
  }
  if (!nonEmptyString(evidence.sandboxName) || !isStrictEvidenceUrl(evidence.noVncUrl)) {
    throw new Error(`${role} smoke evidence is missing a valid HTTPS Sandbox identity URL`);
  }
  if (!Array.isArray(evidence.snapshots) || evidence.snapshots.some((snapshot) => !snapshot || !nonEmptyString(snapshot.id) || snapshot.status !== 'deleted')) {
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
  if (next === source && !pattern.test(source)) throw new Error(`could not update ${field} in ${sourcePath}`);
  source = next;
}

function replaceScopeField(field, team, project) {
  const pattern = new RegExp(
    `(^\\s*${field}:\\s*\\{\\s*team:\\s*)'[^']*'(,\\s*project:\\s*)'[^']*'(\\s*\\},?)$`,
    'm',
  );
  const next = source.replace(pattern, (_match, prefix, separator, suffix) => `${prefix}'${team}'${separator}'${project}'${suffix}`);
  if (next === source && !pattern.test(source)) throw new Error(`could not update ${field} in ${sourcePath}`);
  source = next;
}

function replaceEnumField(field, values, replacement) {
  const pattern = new RegExp(`(^\\s*${field}:\\s*)'(${values.join('|')})'(,?)$`, 'm');
  const next = source.replace(pattern, (_match, prefix, _value, suffix) => `${prefix}'${replacement}'${suffix}`);
  if (next === source && !pattern.test(source)) throw new Error(`could not update ${field} in ${sourcePath}`);
  source = next;
}

function replaceBooleanField(field, replacement) {
  const pattern = new RegExp(`(^\\s*${field}:\\s*)(true|false)(,?)$`, 'm');
  const next = source.replace(pattern, (_match, prefix, _value, suffix) => `${prefix}${replacement}${suffix}`);
  if (next === source && !pattern.test(source)) throw new Error(`could not update ${field} in ${sourcePath}`);
  source = next;
}

source = source.replace(
  /export const VERCEL_IMAGE_REFERENCE =\n\s*'[^']+';/m,
  `export const VERCEL_IMAGE_REFERENCE =\n  '${reference}';`,
);
if (!source.includes(`'${reference}'`)) throw new Error('could not update VERCEL_IMAGE_REFERENCE');
const provenanceSource = `export const VERCEL_IMAGE_PROVENANCE: VercelImageProvenance = ${JSON.stringify(provenance, null, 2)};`;
const provenancePattern = /export const VERCEL_IMAGE_PROVENANCE: VercelImageProvenance = \{[\s\S]*?\n\};/m;
const nextSource = source.replace(provenancePattern, provenanceSource);
if (nextSource === source && !provenancePattern.test(source)) {
  throw new Error('could not update VERCEL_IMAGE_PROVENANCE');
}
source = nextSource;
replaceStringField('provenanceDigest', provenanceDigest);
replaceStringField('sourceCommit', args.get('source-commit'));
replaceStringField('publisherSmokeUrl', args.get('publisher-url'));
replaceStringField('consumerSmokeUrl', args.get('consumer-url'));
replaceScopeField('publisher', args.get('publisher-team'), args.get('publisher-project'));
replaceScopeField('consumer', args.get('consumer-team'), args.get('consumer-project'));
replaceEnumField('publisherSmokeStatus', ['pending', 'passed'], 'passed');
replaceEnumField('consumerSmokeStatus', ['pending', 'passed'], 'passed');
replaceBooleanField('crossProjectVerified', 'true');
await writeFile(sourcePath, source);
console.log(`prepared promotion pin for ${reference}`);
