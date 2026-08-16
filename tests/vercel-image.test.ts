import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseVercelImageReference,
  VERCEL_IMAGE_PIN,
  VERCEL_IMAGE_PROVENANCE,
  validateVercelImagePin,
} from '../src/providers/vercel/image.js';
import { assertReleaseProvenanceMatches } from '../src/providers/vercel/release-validation.js';

const reference = 'vcr.vercel.com/publisher-team/publisher-project/devbox@sha256:' + 'a'.repeat(64);
const provenanceDigest = 'sha256:' + 'b'.repeat(64);
const sourceCommit = '4af448f5daba0f9daf02071250f4f5ad389c80df';

function validPin(overrides: Record<string, unknown> = {}) {
  return {
    reference,
    provenance: VERCEL_IMAGE_PROVENANCE,
    provenanceDigest,
    sourceCommit,
    publisherSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/100',
    consumerSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/101',
    publisher: { team: 'publisher-team', project: 'publisher-project' },
    consumer: { team: 'consumer-team', project: 'consumer-project' },
    testedReference: reference,
    publisherSmokeStatus: 'passed' as const,
    consumerSmokeStatus: 'passed' as const,
    crossProjectVerified: true,
    ...overrides,
  };
}

describe('Vercel image pin validation', () => {
  it('accepts a fully-qualified immutable public digest with mirrored provenance', () => {
    const result = validateVercelImagePin(validPin());

    expect(result.ok).toBe(true);
    expect(parseVercelImageReference(result.reference!.registry + '/' + result.reference!.team + '/' + result.reference!.project + '/' + result.reference!.repository + '@' + result.reference!.digest).digest).toBe(
      'sha256:' + 'a'.repeat(64),
    );
  });

  it('rejects an uninitialized image or provenance digest even when shape looks valid', () => {
    const result = validateVercelImagePin(validPin({
      reference: 'vcr.vercel.com/team/project/repo@sha256:' + '0'.repeat(64),
      provenanceDigest: 'sha256:' + '0'.repeat(64),
      sourceCommit: '0'.repeat(40),
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('uninitialized');
  });

  it('rejects malformed provenance and publisher/reference scope mismatches', () => {
    const malformedProvenance = structuredClone(VERCEL_IMAGE_PROVENANCE);
    malformedProvenance.baseImages.ubuntu = 'docker.io/library/ubuntu:26.04';
    const malformed = validateVercelImagePin(validPin({ provenance: malformedProvenance }));
    expect(malformed.ok).toBe(false);
    expect(malformed.errors.join(' ')).toContain('base images must be digest-pinned');

    const mismatched = validateVercelImagePin(validPin({
      publisher: { team: 'different-team', project: 'publisher-project' },
    }));
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errors.join(' ')).toContain('publisher scope must match image reference');
  });

  it('requires complete, correlated managed and mirrored runtime inventories', () => {
    const empty = structuredClone(VERCEL_IMAGE_PROVENANCE);
    empty.observedManagedVmi.versions = {};
    empty.runtimePackages = {};
    const emptyResult = validateVercelImagePin(validPin({ provenance: empty }));
    expect(emptyResult.ok).toBe(false);
    expect(emptyResult.errors.join(' ')).toMatch(/managed VMI version inventory must include|required runtime package inventory/);

    const mismatched = structuredClone(VERCEL_IMAGE_PROVENANCE);
    mismatched.observedManagedVmi.versions.node = '23.0.0';
    mismatched.observedManagedVmi.versions.pnpm = '9.0.0';
    const mismatchedResult = validateVercelImagePin(validPin({ provenance: mismatched }));
    expect(mismatchedResult.ok).toBe(false);
    expect(mismatchedResult.errors.join(' ')).toMatch(/Node version must match|pnpm version must match/);
  });

  it('rejects credential-bearing smoke evidence URL forms', () => {
    for (const [publisherSmokeUrl, consumerSmokeUrl] of [
      ['https://user:password@example.test/publisher', 'https://github.com/a/2'],
      ['https://github.com/a/1?token=secret-value', 'https://github.com/a/2'],
      ['https://github.com/a/1#secret=secret-value', 'https://github.com/a/2'],
    ]) {
      const result = validateVercelImagePin(validPin({ publisherSmokeUrl, consumerSmokeUrl }));
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('HTTPS smoke evidence URL');
    }
  });

  it('binds release metadata to the exact checked-in provenance artifact', () => {
    const raw = readFileSync('images/vercel/provenance.json', 'utf8');
    const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const pin = validPin({ provenanceDigest: digest });

    expect(() => assertReleaseProvenanceMatches(pin, raw)).not.toThrow();
    expect(() => assertReleaseProvenanceMatches(
      { ...pin, provenanceDigest: 'sha256:' + 'c'.repeat(64) },
      raw,
    )).toThrow(/provenanceDigest/);
    expect(() => assertReleaseProvenanceMatches(
      { ...pin, provenance: { ...VERCEL_IMAGE_PROVENANCE, aptSnapshot: '20260802T000000Z' } },
      raw,
    )).toThrow(/provenance does not match/);
  });

  it('keeps the checked-in pin provenance canonical and byte-digest bound', () => {
    const raw = readFileSync('images/vercel/provenance.json', 'utf8');
    const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;

    expect(VERCEL_IMAGE_PIN.provenanceDigest).toBe(digest);
    expect(JSON.stringify(VERCEL_IMAGE_PIN.provenance)).toBe(JSON.stringify(JSON.parse(raw)));
    expect(validateVercelImagePin(VERCEL_IMAGE_PIN).ok).toBe(true);
  });

  it('rejects a floating tag, mismatched smoke reference, and unproven consumer', () => {
    const result = validateVercelImagePin(validPin({
      reference: 'devbox:latest',
      testedReference: 'devbox@sha256:' + 'c'.repeat(64),
      sourceCommit: 'short-sha',
      publisherSmokeUrl: 'http://localhost:1/publisher',
      consumerSmokeUrl: 'http://localhost:1/consumer',
      publisher: { team: 'same', project: 'project' },
      consumer: { team: 'same', project: 'project' },
      publisherSmokeStatus: 'pending',
      consumerSmokeStatus: 'failed',
      crossProjectVerified: false,
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/digest-pinned|floating|sourceCommit|HTTPS|different|testedReference|passed|crossProject/);
  });
});
