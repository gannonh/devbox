#!/usr/bin/env node
/** Update the sole checked-in Vercel image pin after both smoke gates pass. */
import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = process.env.VERCEL_IMAGE_PIN_FILE ?? 'src/providers/vercel/image.ts';
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const required = [
  'reference', 'base-reference', 'source-commit', 'publisher-url', 'consumer-url',
  'publisher-team', 'publisher-project', 'consumer-team', 'consumer-project',
];
for (const key of required) {
  if (!args.get(key)) throw new Error(`--${key} is required`);
}
const reference = args.get('reference');
const baseReference = args.get('base-reference');
if (!/^vcr\.vercel\.com\/[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(reference)) {
  throw new Error('candidate reference must be a fully-qualified VCR digest reference');
}
if (!/^vcr\.vercel\.com\/vercel\/sandbox\/universal@sha256:[a-f0-9]{64}$/.test(baseReference)) {
  throw new Error('base reference must be a digest-pinned Universal VCR reference');
}
if (!/^[a-f0-9]{40}$/.test(args.get('source-commit'))) {
  throw new Error('source commit must be a full commit SHA');
}
for (const key of ['publisher-team', 'publisher-project', 'consumer-team', 'consumer-project']) {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(args.get(key))) {
    throw new Error(`--${key} must be a Vercel slug`);
  }
}
for (const key of ['publisher-url', 'consumer-url']) {
  try {
    if (new URL(args.get(key)).protocol !== 'https:') throw new Error('not https');
  } catch {
    throw new Error(`--${key} must be an HTTPS URL`);
  }
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
source = source.replace("publisherSmokeStatus: 'pending'", "publisherSmokeStatus: 'passed'");
source = source.replace("consumerSmokeStatus: 'pending'", "consumerSmokeStatus: 'passed'");
source = source.replace('crossProjectVerified: false', 'crossProjectVerified: true');
await writeFile(sourcePath, source);
console.log(`prepared promotion pin for ${reference}`);
