import { describe, expect, it } from 'vitest';
import {
  parseVercelImageReference,
  validateVercelImagePin,
} from '../src/providers/vercel/image.js';

describe('Vercel image pin validation', () => {
  it('accepts a fully-qualified immutable public digest with independent smoke evidence', () => {
    const result = validateVercelImagePin({
      reference:
        'vcr.vercel.com/publisher-team/publisher-project/devbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baseReference:
        'vcr.vercel.com/vercel/sandbox/universal@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      baseDigest:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sourceCommit: '4af448f5daba0f9daf02071250f4f5ad389c80df',
      publisherSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/100',
      consumerSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/101',
      publisher: { team: 'publisher-team', project: 'publisher-project' },
      consumer: { team: 'consumer-team', project: 'consumer-project' },
      testedReference:
        'vcr.vercel.com/publisher-team/publisher-project/devbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      publisherSmokeStatus: 'passed',
      consumerSmokeStatus: 'passed',
      crossProjectVerified: true,
    });

    expect(result.ok).toBe(true);
    expect(parseVercelImageReference(result.reference!.registry + '/' + result.reference!.team + '/' + result.reference!.project + '/' + result.reference!.repository + '@' + result.reference!.digest).digest).toBe(
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('rejects an uninitialized digest even when the shape looks valid', () => {
    const result = validateVercelImagePin({
      reference: 'vcr.vercel.com/team/project/repo@sha256:0000000000000000000000000000000000000000000000000000000000000000',
      baseReference: 'vcr.vercel.com/vercel/sandbox/universal@sha256:0000000000000000000000000000000000000000000000000000000000000000',
      baseDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      sourceCommit: '0000000000000000000000000000000000000000',
      publisherSmokeUrl: 'https://github.com/a/1',
      consumerSmokeUrl: 'https://github.com/a/2',
      publisher: { team: 'team', project: 'project' },
      consumer: { team: 'consumer', project: 'project' },
      testedReference: 'vcr.vercel.com/team/project/repo@sha256:0000000000000000000000000000000000000000000000000000000000000000',
      publisherSmokeStatus: 'passed',
      consumerSmokeStatus: 'passed',
      crossProjectVerified: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('uninitialized');
  });

  it('rejects a floating tag, mismatched smoke reference, and unproven consumer', () => {
    const result = validateVercelImagePin({
      reference: 'devbox:latest',
      baseReference: 'vcr.vercel.com/vercel/sandbox/universal:latest',
      baseDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      sourceCommit: 'short-sha',
      publisherSmokeUrl: 'http://localhost:1/publisher',
      consumerSmokeUrl: 'http://localhost:1/consumer',
      publisher: { team: 'same', project: 'project' },
      consumer: { team: 'same', project: 'project' },
      testedReference: 'devbox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      publisherSmokeStatus: 'pending',
      consumerSmokeStatus: 'failed',
      crossProjectVerified: false,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/digest-pinned|floating|base|sourceCommit|HTTPS|different|testedReference|passed|crossProject/);
  });
});
