# Vercel Sandbox Universal mirror

This image mirrors the audited open-source `vercel/sandbox` Universal recipe
on digest-pinned Ubuntu and Bun bases, then adds Chromium, Xvfb, fluxbox,
x11vnc, noVNC/websockify, and a Basic-Auth noVNC proxy. The
checked-in [`provenance.json`](./provenance.json) is the source of truth for
the upstream commit and recipe hashes, observed managed-VMI inventory, base
references, Node checksum, apt snapshot, and exact runtime package versions.

## Build

Build only the pinned `linux/amd64` image; the Dockerfile has no floating base
fallback or runtime package-install path:

```sh
docker buildx build \
  --platform linux/amd64 \
  --load \
  -t devbox-vercel:local \
  images/vercel
```

Build the promoted candidate through `.github/workflows/vercel-image.yml` so
Buildx publishes one zstd-compressed `linux/amd64` manifest that VCR can
optimize and report as ready. The workflow preserves a byte-exact raw inspection
of the selected digest, verifies its SHA-256, and rejects any layer that is not
OCI zstd. It disables
BuildKit's optional attestation index; reviewed provenance remains checked in,
embedded in the image, verified against upstream, and uploaded as workflow
evidence. Do not add credentials or source repositories to this context.

## Runtime

Vercel Sandbox ignores Docker `ENTRYPOINT` and `CMD`; call the explicit
`/usr/local/bin/devbox-start` command after `Sandbox.create()`. Supply
`DEVBOX_NOVNC_PASSWORD` through the SDK command
environment. The exposed proxy port is `DEVBOX_NOVNC_PORT` (6080 by default),
while the upstream noVNC listener remains private on
`DEVBOX_NOVNC_INTERNAL_PORT`. Every HTTP request and WebSocket upgrade requires
Basic Auth; credentials are never query parameters or cookies.

```sh
docker run --rm -e DEVBOX_NOVNC_PASSWORD='local-only' devbox-vercel:local \
  sh -c '/usr/local/bin/devbox-start && exec sleep infinity'
```

Run the local contract check before pushing; it executes bounded version probes
for the agents, runtimes, Chromium, `gh`, and display/proxy tools rather than
only checking that their paths exist:

```sh
images/vercel/check-local-image.sh devbox-vercel:local
```
