import { isStrictEvidenceUrl } from './strict-url.js';

/**
 * The promoted Vercel image contract.
 *
 * A release consumes a public, fully-qualified VCR reference pinned by
 * manifest digest. The candidate workflow records the reviewed open-source
 * Universal recipe provenance before it opens the promotion PR; release
 * validation rejects incomplete or untested pins.
 */

const VCR_HOST = 'vcr.vercel.com';
const SLUG = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?';
const DIGEST = 'sha256:[a-f0-9]{64}';
const FULL_REFERENCE = new RegExp(
  `^${VCR_HOST}/(${SLUG})/(${SLUG})/(${SLUG})@(${DIGEST})$`,
);
const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST_VALUE = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SNAPSHOT = /^\d{8}T\d{6}Z$/;
const BASE_REFERENCE = /^(?:docker\.io\/library\/ubuntu:26\.04|docker\.io\/oven\/bun:1\.3\.14)@sha256:[a-f0-9]{64}$/;
const REQUIRED_RUNTIME_PACKAGES = [
  'npm', 'pnpm', 'python', 'pip', 'uv', 'gh', 'pi', 'claude', 'codex', 'opencode',
] as const;
const REQUIRED_MANAGED_VERSIONS = [
  'user', 'node', 'bun', ...REQUIRED_RUNTIME_PACKAGES,
] as const;

export interface VercelImageReference {
  registry: typeof VCR_HOST;
  team: string;
  project: string;
  repository: string;
  digest: string;
}

export interface VercelImageScope {
  team: string;
  project: string;
}

export interface VercelImageProvenance {
  schemaVersion: 1;
  platform: 'linux/amd64';
  upstream: {
    repository: string;
    commit: string;
    ubuntuDockerfileSha256: string;
    universalDockerfileSha256: string;
  };
  observedManagedVmi: {
    digest: string;
    versions: Record<string, string>;
  };
  baseImages: {
    ubuntu: string;
    bun: string;
  };
  node: {
    version: string;
    platform: 'linux-x64';
    sha256: string;
  };
  chromium: {
    version: string;
    platform: 'linux64';
    url: string;
    sha256: string;
  };
  aptSnapshot: string;
  runtimePackages: Record<string, string>;
}

export interface VercelImagePin {
  /** The only image reference consumed by the Vercel provider. */
  reference: string;
  /** The reviewed open-source Universal recipe and all pinned inputs. */
  provenance: VercelImageProvenance;
  /** SHA-256 of the exact checked-in provenance artifact. */
  provenanceDigest: string;
  /** The devbox repository commit that produced the candidate. */
  sourceCommit: string;
  publisherSmokeUrl: string;
  consumerSmokeUrl: string;
  publisher: VercelImageScope;
  consumer: VercelImageScope;
  /** The exact reference passed to both Sandbox smoke gates. */
  testedReference: string;
  publisherSmokeStatus?: 'passed' | 'failed' | 'pending';
  consumerSmokeStatus?: 'passed' | 'failed' | 'pending';
  crossProjectVerified?: boolean;
}

export interface VercelImagePinValidation {
  ok: boolean;
  reference?: VercelImageReference;
  errors: string[];
}

/**
 * Parse a fully-qualified VCR image reference.
 *
 * Tags, bare project-relative names, and references from another registry are
 * intentionally not accepted here. The thrown error is useful to callers
 * that need a strict parser; use validateVercelImagePin for user-facing lists
 * of errors.
 */
export function parseVercelImageReference(value: string): VercelImageReference {
  const match = FULL_REFERENCE.exec(value);
  if (!match) {
    throw new Error(
      `Expected vcr.vercel.com/<team>/<project>/<repository>@sha256:<64 hex digits>, got ${value}`,
    );
  }

  return {
    registry: VCR_HOST,
    team: match[1],
    project: match[2],
    repository: match[3],
    digest: match[4],
  };
}

function isVercelSlug(value: string): boolean {
  return new RegExp(`^${SLUG}$`).test(value);
}

function isUninitializedDigest(value: string | undefined): boolean {
  return value === 'sha256:' + '0'.repeat(64);
}

function isUninitializedHash(value: string | undefined): boolean {
  return value === '0'.repeat(64);
}

function validateProvenance(provenance: VercelImageProvenance | undefined): string[] {
  const errors: string[] = [];
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['provenance metadata is missing'];
  }
  if (provenance.schemaVersion !== 1) errors.push('provenance schemaVersion must be 1');
  if (provenance.platform !== 'linux/amd64') errors.push('provenance platform must be linux/amd64');
  const upstream = provenance.upstream;
  if (!upstream || typeof upstream !== 'object') {
    errors.push('upstream provenance is missing');
  } else {
    if (!/^https:\/\/github\.com\/vercel\/sandbox$/.test(upstream.repository)) {
      errors.push('upstream repository must be the audited Vercel Sandbox source');
    }
    if (!COMMIT.test(upstream.commit) || /^0+$/.test(upstream.commit)) errors.push('upstream commit must be a full nonzero commit SHA');
    if (!HASH.test(upstream.ubuntuDockerfileSha256) || isUninitializedHash(upstream.ubuntuDockerfileSha256)) {
      errors.push('upstream Ubuntu Dockerfile hash must be a full nonzero SHA-256');
    }
    if (!HASH.test(upstream.universalDockerfileSha256) || isUninitializedHash(upstream.universalDockerfileSha256)) {
      errors.push('upstream Universal Dockerfile hash must be a full nonzero SHA-256');
    }
  }

  const managed = provenance.observedManagedVmi;
  if (!managed || typeof managed !== 'object' || !DIGEST_VALUE.test(managed.digest) || isUninitializedDigest(managed.digest)) {
    errors.push('observed managed VMI digest must be a full nonzero SHA-256');
  }
  if (!managed?.versions || typeof managed.versions !== 'object' || Array.isArray(managed.versions)) {
    errors.push('observed managed VMI version inventory is missing');
  } else {
    if (Object.entries(managed.versions).some(([name, version]) => typeof name !== 'string' || typeof version !== 'string' || version.length === 0)) {
      errors.push('observed managed VMI version inventory is malformed');
    }
    const missingManaged = REQUIRED_MANAGED_VERSIONS.filter((name) => !managed.versions[name]);
    if (missingManaged.length > 0) {
      errors.push(`managed VMI version inventory must include: ${missingManaged.join(', ')}`);
    }
    if (managed.versions.user !== 'ubuntu') errors.push('managed VMI user must be ubuntu');
    if (managed.versions.node !== provenance.node?.version) errors.push('managed VMI Node version must match mirrored Node provenance');
    if (managed.versions.bun !== '1.3.14') errors.push('managed VMI Bun version must match the pinned Bun base');
  }

  const bases = provenance.baseImages;
  if (!bases || typeof bases !== 'object' || !BASE_REFERENCE.test(bases.ubuntu) || !BASE_REFERENCE.test(bases.bun)) {
    errors.push('Ubuntu and Bun base images must be digest-pinned audited references');
  }
  const node = provenance.node;
  if (!node || node.platform !== 'linux-x64' || !VERSION.test(node.version) || !HASH.test(node.sha256) || isUninitializedHash(node.sha256)) {
    errors.push('Node provenance must include an exact linux-x64 version and nonzero SHA-256');
  }
  const chromium = provenance.chromium;
  if (
    !chromium ||
    chromium.platform !== 'linux64' ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(chromium.version) ||
    chromium.url !== `https://storage.googleapis.com/chrome-for-testing-public/${chromium.version}/linux64/chrome-linux64.zip` ||
    !HASH.test(chromium.sha256) ||
    isUninitializedHash(chromium.sha256)
  ) {
    errors.push('Chromium provenance must include an exact official linux64 archive and nonzero SHA-256');
  }
  if (!SNAPSHOT.test(provenance.aptSnapshot)) errors.push('aptSnapshot must be a dated UTC snapshot');
  if (!provenance.runtimePackages || typeof provenance.runtimePackages !== 'object' || Array.isArray(provenance.runtimePackages)) {
    errors.push('runtime package provenance is missing');
  } else {
    if (Object.entries(provenance.runtimePackages).some(([name, version]) => typeof name !== 'string' || !VERSION.test(String(version)))) {
      errors.push('runtime package provenance must use exact semantic versions');
    }
    const missingPackages = REQUIRED_RUNTIME_PACKAGES.filter((name) => !provenance.runtimePackages[name]);
    if (missingPackages.length > 0) {
      errors.push(`required runtime package inventory must include: ${missingPackages.join(', ')}`);
    }
    if (managed?.versions && typeof managed.versions === 'object' && !Array.isArray(managed.versions)) {
      for (const name of REQUIRED_RUNTIME_PACKAGES) {
        if (provenance.runtimePackages[name] && provenance.runtimePackages[name] !== managed.versions[name]) {
          errors.push(`${name} version must match the observed managed VMI`);
        }
      }
    }
  }
  return errors;
}

/**
 * Validate the release-facing image pin and all evidence needed to promote it.
 * This is deliberately pure so package-quality checks and workflow scripts can
 * exercise the same rules without credentials or a live Vercel project.
 */
export function validateVercelImagePin(pin: VercelImagePin): VercelImagePinValidation {
  const errors: string[] = [];
  let reference: VercelImageReference | undefined;

  try {
    reference = parseVercelImageReference(pin.reference);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'image reference is malformed');
  }

  if (!pin.reference.includes('@sha256:')) {
    errors.push('image reference must be immutable and digest-pinned, not a floating tag');
  }
  if (isUninitializedDigest(reference?.digest)) {
    errors.push('image reference contains an uninitialized digest');
  }

  errors.push(...validateProvenance(pin.provenance));
  if (!DIGEST_VALUE.test(pin.provenanceDigest) || isUninitializedDigest(pin.provenanceDigest)) {
    errors.push('provenanceDigest must be a full nonzero SHA-256');
  }

  if (!COMMIT.test(pin.sourceCommit)) {
    errors.push('sourceCommit must be a full 40-character hexadecimal commit SHA');
  } else if (/^0{40}$/.test(pin.sourceCommit)) {
    errors.push('sourceCommit is uninitialized');
  }

  if (!isStrictEvidenceUrl(pin.publisherSmokeUrl)) {
    errors.push('publisherSmokeUrl must be an HTTPS smoke evidence URL');
  }
  if (!isStrictEvidenceUrl(pin.consumerSmokeUrl)) {
    errors.push('consumerSmokeUrl must be an HTTPS smoke evidence URL');
  }
  if (pin.publisherSmokeUrl === pin.consumerSmokeUrl) {
    errors.push('publisher and consumer smoke evidence must be independent URLs');
  }

  if (!pin.publisher.team || !pin.publisher.project) {
    errors.push('publisher scope must include team and project');
  } else {
    if (!isVercelSlug(pin.publisher.team)) errors.push('publisher team must be a Vercel slug');
    if (!isVercelSlug(pin.publisher.project)) errors.push('publisher project must be a Vercel slug');
  }
  if (!pin.consumer.team || !pin.consumer.project) {
    errors.push('consumer scope must include team and project');
  } else {
    if (!isVercelSlug(pin.consumer.team)) errors.push('consumer team must be a Vercel slug');
    if (!isVercelSlug(pin.consumer.project)) errors.push('consumer project must be a Vercel slug');
  }
  if (reference) {
    if (pin.publisher.team !== reference.team || pin.publisher.project !== reference.project) {
      errors.push('publisher scope must match image reference team and project');
    }
  }
  if (
    pin.publisher.team === pin.consumer.team &&
    pin.publisher.project === pin.consumer.project
  ) {
    errors.push('consumer smoke must use a different Vercel team or project');
  }

  if (pin.testedReference !== pin.reference) {
    errors.push('testedReference must exactly match the promoted image reference');
  }
  if (pin.publisherSmokeStatus !== 'passed') {
    errors.push('publisher smoke evidence is not marked passed');
  }
  if (pin.consumerSmokeStatus !== 'passed') {
    errors.push('consumer smoke evidence is not marked passed');
  }
  if (pin.crossProjectVerified !== true) {
    errors.push('crossProjectVerified must be true before promotion');
  }

  return { ok: errors.length === 0, reference, errors };
}

/** Throw a compact error when a release pin is not promotable. */
export function assertValidVercelImagePin(pin: VercelImagePin): VercelImageReference {
  const result = validateVercelImagePin(pin);
  if (!result.ok) {
    throw new Error(`Invalid Vercel image pin:\n- ${result.errors.join('\n- ')}`);
  }
  return result.reference!;
}

export const VERCEL_IMAGE_REFERENCE =
  'vcr.vercel.com/devbox-publisher/devbox-image/devbox@sha256:0000000000000000000000000000000000000000000000000000000000000000';

/** The exact audited mirror inputs copied from images/vercel/provenance.json. */
export const VERCEL_IMAGE_PROVENANCE: VercelImageProvenance = {
  schemaVersion: 1,
  platform: 'linux/amd64',
  upstream: {
    repository: 'https://github.com/vercel/sandbox',
    commit: '90fa48d5728d46d40fbfb6495c2d720aeb3f7a0f',
    ubuntuDockerfileSha256: 'afaa5535d925d4e6344ca2971c041c68a3f49722531115c9ab63462333f0656a',
    universalDockerfileSha256: 'e53e28f8c8d7b502340073127d0cc8c29f0b5765b10ba961a0ad6d153fabc69a',
  },
  observedManagedVmi: {
    digest: 'sha256:0e3e3617e824397f170fc7c43ccaa565dd7ac36518e83ead3d41e077cd9f6ec7',
    versions: {
      user: 'ubuntu',
      node: '24.19.0',
      npm: '11.17.0',
      pnpm: '11.20.0',
      bun: '1.3.14',
      python: '3.14.4',
      pip: '25.1.1',
      uv: '0.12.2',
      gh: '2.97.0',
      pi: '0.84.1',
      claude: '2.1.224',
      codex: '0.147.0',
      opencode: '1.18.15',
    },
  },
  baseImages: {
    ubuntu: 'docker.io/library/ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03',
    bun: 'docker.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4',
  },
  node: {
    version: '24.19.0',
    platform: 'linux-x64',
    sha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
  },
  chromium: {
    version: '152.0.7977.42',
    platform: 'linux64',
    url: 'https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.42/linux64/chrome-linux64.zip',
    sha256: 'cb77f4781cad7d5e06fcc78b4476e6a6375616e7278dc313abaa9db22ed4674e',
  },
  aptSnapshot: '20260801T000000Z',
  runtimePackages: {
    npm: '11.17.0',
    pnpm: '11.20.0',
    python: '3.14.4',
    pip: '25.1.1',
    uv: '0.12.2',
    gh: '2.97.0',
    pi: '0.84.1',
    claude: '2.1.224',
    codex: '0.147.0',
    opencode: '1.18.15',
  },
};

/**
 * Bootstrap metadata is intentionally not release-valid until the secret-gated
 * candidate workflow has produced a real public digest and independent smoke
 * evidence. The workflow's promotion PR replaces these values atomically.
 */
export const VERCEL_IMAGE_PIN: VercelImagePin = {
  reference: VERCEL_IMAGE_REFERENCE,
  provenance: VERCEL_IMAGE_PROVENANCE,
  provenanceDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  sourceCommit: '0000000000000000000000000000000000000000',
  publisherSmokeUrl: 'https://example.invalid/vercel-publisher-smoke',
  consumerSmokeUrl: 'https://example.invalid/vercel-consumer-smoke',
  publisher: { team: 'devbox-publisher', project: 'devbox-image' },
  consumer: { team: 'devbox-consumer', project: 'devbox-consumer-image' },
  testedReference: VERCEL_IMAGE_REFERENCE,
  publisherSmokeStatus: 'pending',
  consumerSmokeStatus: 'pending',
  crossProjectVerified: false,
};
