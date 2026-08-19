import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  readReleasePin,
  resolveVercelImage,
  VercelImageResolutionError,
  VERCEL_IMAGE_REPOSITORY,
} from '../src/providers/vercel/image-resolution.js';
import { createVcrChannelResolver } from '../src/providers/vercel/image-registry.js';
import { VERCEL_IMAGE_PROVENANCE } from '../src/providers/vercel/image.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const credentials = { token: 'vercel-token', teamId: 'team-1', projectId: 'project-1' };

/** A pin shaped like the one the publish step emits. */
function releasePin(reference = `${VERCEL_IMAGE_REPOSITORY}@${DIGEST}`) {
  return {
    reference,
    provenance: VERCEL_IMAGE_PROVENANCE,
    provenanceDigest: `sha256:${'c'.repeat(64)}`,
    sourceCommit: 'd'.repeat(40),
    publisherSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/1#publisher-smoke',
    consumerSmokeUrl: 'https://github.com/gannonh/devbox/actions/runs/1#consumer-smoke',
    publisher: { team: 'astro-labs', project: 'devbox' },
    consumer: { team: 'astro-labs', project: 'devbox-uat' },
    testedReference: reference,
    publisherSmokeStatus: 'passed' as const,
    consumerSmokeStatus: 'passed' as const,
    crossProjectVerified: true,
  };
}

async function writePin(pin: unknown): Promise<URL> {
  const directory = await mkdtemp(join(tmpdir(), 'devbox-image-pin-'));
  const path = join(directory, 'vercel-image-pin.json');
  await writeFile(path, JSON.stringify(pin));
  return pathToFileURL(path);
}

/** A URL that does not exist, standing in for a git checkout. */
function missingPinUrl(): URL {
  return pathToFileURL(join(tmpdir(), 'devbox-absent-pin', `${Math.random()}.json`));
}

describe('Vercel image resolution', () => {
  it('resolves the channel tag to a digest when no release pin is present', async () => {
    const resolveChannel = vi.fn(async () => DIGEST);

    const resolution = await resolveVercelImage({
      env: {},
      credentials,
      resolveChannel,
      releasePinUrl: missingPinUrl(),
    });

    expect(resolution).toEqual({
      reference: `${VERCEL_IMAGE_REPOSITORY}@${DIGEST}`,
      source: 'channel',
    });
    expect(resolveChannel).toHaveBeenCalledWith('nightly', credentials, undefined);
  });

  it('prefers the frozen release pin over the channel and never looks one up', async () => {
    const resolveChannel = vi.fn(async () => OTHER_DIGEST);
    const pinUrl = await writePin(releasePin());

    const resolution = await resolveVercelImage({
      env: {},
      credentials,
      resolveChannel,
      releasePinUrl: pinUrl,
    });

    expect(resolution).toEqual({
      reference: `${VERCEL_IMAGE_REPOSITORY}@${DIGEST}`,
      source: 'release-pin',
    });
    expect(resolveChannel).not.toHaveBeenCalled();
  });

  it('lets an explicit override win in a checkout', async () => {
    const override = `${VERCEL_IMAGE_REPOSITORY}@${OTHER_DIGEST}`;
    const resolveChannel = vi.fn(async () => DIGEST);

    const resolution = await resolveVercelImage({
      env: { DEVBOX_VERCEL_IMAGE: override },
      credentials,
      resolveChannel,
      releasePinUrl: missingPinUrl(),
    });

    expect(resolution).toEqual({ reference: override, source: 'override' });
    expect(resolveChannel).not.toHaveBeenCalled();
  });

  it('refuses to let an override redirect a published release', async () => {
    const pinUrl = await writePin(releasePin());

    await expect(resolveVercelImage({
      env: { DEVBOX_VERCEL_IMAGE: `${VERCEL_IMAGE_REPOSITORY}@${OTHER_DIGEST}` },
      credentials,
      resolveChannel: vi.fn(async () => DIGEST),
      releasePinUrl: pinUrl,
    })).rejects.toThrow(/cannot override the image pinned in a published devbox release/);
  });

  it('rejects a floating override that is not digest-pinned', async () => {
    await expect(resolveVercelImage({
      env: { DEVBOX_VERCEL_IMAGE: `${VERCEL_IMAGE_REPOSITORY}:nightly` },
      credentials,
      resolveChannel: vi.fn(async () => DIGEST),
      releasePinUrl: missingPinUrl(),
    })).rejects.toThrow();
  });

  it('fails closed when the channel does not resolve to a manifest digest', async () => {
    await expect(resolveVercelImage({
      env: {},
      credentials,
      resolveChannel: vi.fn(async () => 'nightly'),
      releasePinUrl: missingPinUrl(),
    })).rejects.toThrow(/did not resolve to a manifest digest/);
  });

  it('fails closed on a malformed pin rather than falling back to the channel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devbox-image-pin-'));
    const path = join(directory, 'vercel-image-pin.json');
    await writeFile(path, '{ not json');

    expect(() => readReleasePin(pathToFileURL(path))).toThrow(VercelImageResolutionError);
  });

  it('rejects a pin whose reference is not a fully-qualified digest', async () => {
    const pinUrl = await writePin(releasePin(`${VERCEL_IMAGE_REPOSITORY}:nightly`));

    expect(() => readReleasePin(pinUrl)).toThrow();
  });

  it('treats an absent pin file as a checkout rather than an error', () => {
    expect(readReleasePin(missingPinUrl())).toBeUndefined();
  });
});

describe('VCR channel resolution', () => {
  const repository = 'vcr.vercel.com/astro-labs/devbox/devbox';

  function respond(init: { status?: number; digest?: string }): typeof globalThis.fetch {
    return (async () => new Response(null, {
      status: init.status ?? 200,
      headers: init.digest ? { 'docker-content-digest': init.digest } : {},
    })) as unknown as typeof globalThis.fetch;
  }

  it('reads the manifest digest using team-id/token basic auth', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
    }) as unknown as typeof globalThis.fetch;

    const resolve = createVcrChannelResolver({ fetch: fetchImpl, repository });
    await expect(resolve('nightly', credentials)).resolves.toBe(DIGEST);

    expect(calls[0]?.url).toBe('https://vcr.vercel.com/v2/astro-labs/devbox/devbox/manifests/nightly');
    const expected = `Basic ${Buffer.from('team-1:vercel-token').toString('base64')}`;
    expect(calls[0]?.headers.get('authorization')).toBe(expected);
    expect(calls[0]?.headers.get('accept')).toContain('application/vnd.oci.image.manifest.v1+json');
  });

  it('gives an actionable error with a bypass when credentials cannot read the channel', async () => {
    const resolve = createVcrChannelResolver({ fetch: respond({ status: 403 }), repository });

    await expect(resolve('nightly', credentials)).rejects.toThrow(/not authorized.*DEVBOX_VERCEL_IMAGE/s);
  });

  it('distinguishes a missing channel from an authorization failure', async () => {
    const resolve = createVcrChannelResolver({ fetch: respond({ status: 404 }), repository });

    await expect(resolve('nightly', credentials)).rejects.toThrow(/does not exist/);
  });

  it('derives the digest from the manifest bytes when the header is absent', async () => {
    // Docker-Content-Digest is only RECOMMENDED, and the digest is by
    // definition the hash of the manifest the registry just returned.
    const manifest = '{"schemaVersion":2,"layers":[]}';
    const expected = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
    const fetchImpl = (async () => new Response(manifest, { status: 200 })) as unknown as typeof globalThis.fetch;

    const resolve = createVcrChannelResolver({ fetch: fetchImpl, repository });
    await expect(resolve('nightly', credentials)).resolves.toBe(expected);
  });

  it('fails closed when the registry returns neither a digest header nor a manifest', async () => {
    const resolve = createVcrChannelResolver({ fetch: respond({ status: 200 }), repository });

    await expect(resolve('nightly', credentials)).rejects.toThrow(/did not return a manifest digest/);
  });

  it('never leaks the token through a transport error', async () => {
    const authorization = `Basic ${Buffer.from('team-1:vercel-token').toString('base64')}`;
    const fetchImpl = (async () => {
      throw new Error(`socket hang up while sending ${authorization}`);
    }) as unknown as typeof globalThis.fetch;
    const resolve = createVcrChannelResolver({ fetch: fetchImpl, repository });

    const error = await resolve('nightly', credentials).catch((thrown: unknown) => thrown);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain('vercel-token');
    expect(message).not.toContain(authorization);
  });
});
