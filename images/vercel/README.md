# Vercel Sandbox image

This image extends the digest-pinned `vcr.vercel.com/vercel/sandbox/universal`
image with Chromium, Xvfb, fluxbox, x11vnc, noVNC/websockify, and a small
HTTP/WebSocket Basic Auth proxy. Universal already supplies `pi`, Claude Code,
Codex, OpenCode, Node.js, Bun, Python, `gh`, `sudo`, and common utilities.

## Build

The Universal digest is intentionally supplied as a required build argument;
there is no floating fallback:

```sh
export UNIVERSAL_BASE_DIGEST=sha256:<64-hex-digits>
docker buildx build \
  --platform linux/amd64 \
  --build-arg UNIVERSAL_BASE_DIGEST="${UNIVERSAL_BASE_DIGEST#sha256:}" \
  --load \
  -t devbox-vercel:local \
  images/vercel
```

Build the promoted candidate through `.github/workflows/vercel-image.yml` so
Buildx uses zstd compression and the exact base digest detected in the Vercel
Sandbox.  Do not add credentials or source repositories to this context.

## Runtime

Vercel Sandbox ignores Docker `ENTRYPOINT` and `CMD`; call the explicit
`/usr/local/bin/devbox-start` command after `Sandbox.create()`. Supply
`DEVBOX_NOVNC_PASSWORD` through the SDK command environment. The exposed port
is `DEVBOX_NOVNC_PORT` (6081 by default), and both `/vnc.html` and its WebSocket
upgrade require HTTP Basic Auth.

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
