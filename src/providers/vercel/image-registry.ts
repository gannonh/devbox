import { createHash } from 'node:crypto';
import type { VercelCredentials } from './auth.js';
import {
  VercelImageResolutionError,
  VERCEL_IMAGE_REPOSITORY,
  type VercelImageChannelResolver,
} from './image-resolution.js';

/**
 * Resolve a channel tag to a manifest digest through the VCR registry.
 *
 * The registry is the same surface a `docker pull` uses, authenticated exactly
 * as the image workflow authenticates Buildx: the team ID is the username and
 * the Vercel token is the password. The devbox repository is public, so any
 * authenticated Vercel account may read it — which is the property the
 * consumer smoke gate exists to prove.
 */

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(',');

const DEFAULT_TIMEOUT_MS = 10_000;

export interface VcrChannelResolverOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  repository?: string;
  timeoutMs?: number;
}

function manifestUrl(repository: string, tag: string): string {
  const separator = repository.indexOf('/');
  if (separator <= 0) {
    throw new VercelImageResolutionError(`Vercel image repository '${repository}' is malformed`);
  }
  const host = repository.slice(0, separator);
  const name = repository.slice(separator + 1);
  return `https://${host}/v2/${name}/manifests/${encodeURIComponent(tag)}`;
}

export function createVcrChannelResolver(
  options: VcrChannelResolverOptions = {},
): VercelImageChannelResolver {
  const doFetch = options.fetch ?? globalThis.fetch;
  const repository = options.repository ?? VERCEL_IMAGE_REPOSITORY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (channel: string, credentials: VercelCredentials, signal?: AbortSignal) => {
    const authorization = `Basic ${Buffer
      .from(`${credentials.teamId}:${credentials.token}`)
      .toString('base64')}`;

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await doFetch(manifestUrl(repository, channel), {
        method: 'GET',
        headers: { accept: MANIFEST_ACCEPT, authorization },
        signal: combined,
      });
    } catch (error) {
      // Never surface the token through a transport error message.
      const detail = error instanceof Error ? error.message : String(error);
      throw new VercelImageResolutionError(
        `Could not reach the Vercel container registry to resolve image channel '${channel}': ${detail.split(authorization).join('[REDACTED]')}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new VercelImageResolutionError(
        `Vercel credentials are not authorized to read image channel '${channel}' from ${repository}. `
        + 'Set DEVBOX_VERCEL_IMAGE to a fully-qualified digest reference to bypass channel resolution.',
      );
    }
    if (response.status === 404) {
      throw new VercelImageResolutionError(
        `Vercel image channel '${channel}' does not exist in ${repository}`,
      );
    }
    if (!response.ok) {
      throw new VercelImageResolutionError(
        `Vercel container registry returned ${response.status} resolving image channel '${channel}'`,
      );
    }

    // Docker-Content-Digest is only RECOMMENDED by the distribution spec. When
    // it is absent the digest is still knowable: it is the hash of the manifest
    // bytes the registry just returned.
    const reported = response.headers.get('docker-content-digest')?.trim();
    if (reported) return reported;

    const manifest = Buffer.from(await response.arrayBuffer());
    if (manifest.length === 0) {
      throw new VercelImageResolutionError(
        `Vercel container registry did not return a manifest digest for image channel '${channel}'`,
      );
    }
    return `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
  };
}
