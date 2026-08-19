#!/usr/bin/env node
/**
 * Point a tag at an existing manifest without changing its digest.
 *
 * `docker buildx imagetools create` wraps the source in an OCI index, so the
 * new tag resolves to the index digest rather than the manifest that was built
 * and smoked. VCR also reports readiness on the child manifest, not the index
 * (see ADR 0001), so an index-wrapped channel tag is wrong twice over.
 *
 * The OCI distribution spec gives the exact primitive: GET the manifest bytes
 * by digest, then PUT those same bytes under the tag. The registry recomputes
 * the digest from the content, so the tag necessarily resolves to the identical
 * manifest.
 */
import { createHash } from 'node:crypto';

const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(',');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!key?.startsWith('--') || !process.argv[index + 1]) {
    throw new Error(`missing value for ${key ?? 'argument'}`);
  }
  args.set(key.slice(2), process.argv[index + 1]);
}

const repository = args.get('repository');
const digest = args.get('digest');
const tag = args.get('tag');
for (const [name, value] of [['repository', repository], ['digest', digest], ['tag', tag]]) {
  if (!value) throw new Error(`--${name} is required`);
}
if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
  throw new Error('--digest must be a sha256 manifest digest');
}
if (!/^[A-Za-z0-9._-]{1,128}$/.test(tag)) throw new Error('--tag is not a valid OCI tag');

const username = process.env.VERCEL_PUBLISHER_TEAM_ID ?? process.env.VERCEL_TEAM_ID;
const password = process.env.VERCEL_PUBLISHER_TOKEN ?? process.env.VERCEL_TOKEN;
if (!username || !password) {
  throw new Error('VERCEL_PUBLISHER_TEAM_ID and VERCEL_PUBLISHER_TOKEN are required');
}
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const separator = repository.indexOf('/');
if (separator <= 0) throw new Error('--repository must be <host>/<team>/<project>/<repository>');
const host = repository.slice(0, separator);
const name = repository.slice(separator + 1);
const manifestUrl = (reference) => `https://${host}/v2/${name}/manifests/${reference}`;

function redact(message) {
  return String(message).split(password).join('[REDACTED]').split(authorization).join('[REDACTED]');
}

async function main() {
  const source = await fetch(manifestUrl(digest), {
    headers: { accept: MANIFEST_TYPES, authorization },
  });
  if (!source.ok) {
    throw new Error(`could not read manifest ${digest}: HTTP ${source.status}`);
  }
  const contentType = source.headers.get('content-type');
  if (!contentType) throw new Error('registry did not report a manifest content type');
  // Bytes must be forwarded verbatim: any re-serialization changes the digest.
  const body = Buffer.from(await source.arrayBuffer());

  const put = await fetch(manifestUrl(tag), {
    method: 'PUT',
    headers: { authorization, 'content-type': contentType },
    body,
  });
  if (!put.ok) {
    throw new Error(`could not tag ${tag}: HTTP ${put.status} ${redact(await put.text())}`);
  }

  const verify = await fetch(manifestUrl(tag), {
    method: 'GET',
    headers: { accept: MANIFEST_TYPES, authorization },
  });
  if (!verify.ok) throw new Error(`could not verify tag ${tag}: HTTP ${verify.status}`);
  // Docker-Content-Digest is only RECOMMENDED by the distribution spec, so fall
  // back to hashing the returned bytes -- which is what the digest means anyway.
  const verified = Buffer.from(await verify.arrayBuffer());
  const resolved = verify.headers.get('docker-content-digest')
    ?? `sha256:${createHash('sha256').update(verified).digest('hex')}`;
  if (resolved !== digest) {
    throw new Error(`tag ${tag} resolved to ${resolved}, expected ${digest}`);
  }
  console.log(`${tag} -> ${digest}`);
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
