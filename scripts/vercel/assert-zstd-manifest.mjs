import { createHash } from 'node:crypto';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_ZSTD_LAYER = 'application/vnd.oci.image.layer.v1.tar+zstd';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function assertDescriptor(descriptor, expectedMediaType, label) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error(`${label} descriptor is missing`);
  }
  if (descriptor.mediaType !== expectedMediaType) {
    throw new Error(`${label} must use ${expectedMediaType}, got ${descriptor.mediaType ?? 'missing'}`);
  }
  if (!DIGEST.test(descriptor.digest)) throw new Error(`${label} digest is malformed`);
  if (!Number.isInteger(descriptor.size) || descriptor.size <= 0) throw new Error(`${label} size must be a positive integer`);
}

try {
  const expectedDigest = argument('--expected-digest');
  if (!DIGEST.test(expectedDigest)) throw new Error('--expected-digest must be a full sha256 digest');

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  const actualDigest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  if (actualDigest !== expectedDigest) {
    throw new Error(`raw manifest digest ${actualDigest} does not match selected digest ${expectedDigest}`);
  }
  const manifest = JSON.parse(raw.toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('raw manifest must be a JSON object');
  }
  if (manifest.schemaVersion !== 2 || manifest.mediaType !== OCI_MANIFEST) {
    throw new Error(`selected digest must resolve to a direct OCI manifest (${OCI_MANIFEST})`);
  }
  assertDescriptor(manifest.config, OCI_CONFIG, 'config');
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    throw new Error('direct OCI manifest must contain at least one layer');
  }
  for (const [index, layer] of manifest.layers.entries()) {
    assertDescriptor(layer, OCI_ZSTD_LAYER, `layer ${index}`);
  }

  process.stdout.write(`${JSON.stringify({
    manifestDigest: expectedDigest,
    manifestMediaType: manifest.mediaType,
    compression: 'zstd',
    layerCount: manifest.layers.length,
    layerMediaTypes: [...new Set(manifest.layers.map((layer) => layer.mediaType))],
    layerDigests: manifest.layers.map((layer) => layer.digest),
  }, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
