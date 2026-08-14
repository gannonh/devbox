---
type: ADR
title: Digest-pinned Vercel image promotion
status: Accepted
issue: https://github.com/gannonh/devbox/issues/4
---

# Digest-pinned Vercel image promotion

## Decision

Devbox's Vercel Sandbox image is built from a manifest-digest-pinned
`vcr.vercel.com/vercel/sandbox/universal` base and is promoted only as a
fully-qualified public VCR digest reference. The Dockerfile receives the base
manifest digest as a required build argument, builds only `linux/amd64` with
Buildx zstd output, and defines neither `ENTRYPOINT` nor `CMD`; Sandbox startup
is explicit through `/usr/local/bin/devbox-start`.

A candidate is immutable (`sha-<source-commit>`), waits for VCR readiness, and
must pass two real Sandbox gates: publisher-project filesystem/runtime checks
and independent consumer-project public-pull checks. The pin in
`src/providers/vercel/image.ts` is changed only by a reviewed promotion PR
that records the candidate digest, base digest, source commit, and both smoke
URLs. A scheduled Universal-drift check may open that PR but cannot merge or
release it.

## Rationale

VCR prepares custom images asynchronously and Sandbox does not execute Docker
entrypoint defaults. Digest identity and explicit startup therefore need to be
validated in the same real Sandbox used for promotion. A separate consumer
credential set proves that public visibility works across project boundaries,
not merely through the publisher's private registry permissions. Centralized
artifact redaction keeps readiness, session, snapshot, timing, and cleanup
evidence useful without placing credentials in logs or image layers.

## Consequences

- The first publisher repository visibility change is an explicit operator
  action; CI verifies visibility and never changes it silently.
- A live publisher token, separate consumer token, public VCR repository, and
  Sandbox-enabled projects are required for the candidate workflow.
- A failed or same-project-only candidate cannot update the release pin.
- Rollback is a reviewed pin change plus package release. Existing named
  Sandboxes keep their creation image until removal/recreation.

## Rejected alternatives

- Floating `latest` or a bare project-relative image reference: these allow
  the tested bytes to differ from the promoted bytes.
- Docker `ENTRYPOINT`/`CMD`: Vercel Sandbox ignores both for custom images.
- Scheduled auto-promotion: upstream drift must pass the same smoke and review
  gates as a manually requested candidate.
- A registry visibility mutation in CI: public publication is a one-time,
  auditable operator decision.
