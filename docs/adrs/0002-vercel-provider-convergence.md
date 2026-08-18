---
type: ADR
title: "Vercel provider convergence and release proof"
description: "Direct SDK lifecycle, public digest pin, Basic Auth, and evidence-gated release."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/7
---

# Vercel provider convergence and release proof

## Decision

Use the direct `@vercel/sandbox` v3 SDK behind the provider boundary. Release
consumes one public, fully-qualified, digest-pinned custom image reference and
requires independent publisher and consumer smoke evidence plus the five-run
readiness benchmark. Runtime credentials/configuration are synchronized after
creation and never baked into the image. The noVNC proxy uses fixed-username
(`devbox`) HTTP Basic Auth, while the password is retrieved only through
`--password` and is never put in a URL.

## Alternatives rejected

- A per-project Vercel base image or fork would duplicate the upstream image
  and make cross-project consumption unverifiable.
- Wrapping or parsing the official Sandbox CLI would duplicate lifecycle
  semantics and hide SDK errors; the provider uses the stable SDK directly.
- Floating tags or a bare project-relative image would allow image drift and
  cannot prove the exact artifact that was tested.

## Security and operations

The public image is generic. GitHub/Vercel credentials, `.env`, Pi data, and
display passwords enter only at runtime. App ports come from `forwardPorts`;
VNC `5900` and the internal noVNC listener stay private. Cleanup proves
terminal sessions and snapshot deletion before removing mode-`0600` metadata.
Partial cleanup retains only non-secret scope/residual IDs for retry.

## Updates and rollback

Upstream changes are reviewed through the image workflow. A promotion updates
the single image pin only after exact-digest publisher/consumer smoke passes.
Rollback is another reviewed pin to a previously tested digest followed by
the normal release gates. The benchmark and UAT artifacts remain the evidence
for the release decision.
