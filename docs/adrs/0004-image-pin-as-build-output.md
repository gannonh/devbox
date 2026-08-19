---
type: ADR
title: "Image pin as a build output"
description: "Nothing in git carries a digest; the pin is emitted at publish time and channels carry development."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/7
---

# Image pin as a build output

## Decision

**Tags for development, digests for releases.** Nothing in the source tree
contains an image digest.

- A published package carries a frozen pin, emitted at publish time from
  validated publisher and consumer smoke evidence.
- A git checkout carries no pin and resolves a channel tag (`nightly`) to a
  digest at launch, caching the result.
- `DEVBOX_VERCEL_IMAGE` overrides the channel for local image work, and is
  refused when a release pin is present.

Three workflows exist: **CI** (credential-free, on every push and pull request),
**Nightly** (scheduled on main or dispatched at any ref: builds, smokes, and
publishes a prerelease), and **Release** (manual: promotes a proven nightly
digest to `stable` and `latest` without rebuilding).

## Context

The digest used to be a `const` in `src/providers/vercel/image.ts`. Building an
image therefore required committing its digest back into the thing it was built
from, so every image change took two pull requests — the source change, then a
workflow-authored pin bump — with a window in between where `main` carried image
source the pinned image did not reflect.

That circularity was the *only* cause. Everything heavy followed from it: a
write-capable promotion job, exact-SHA `vcr:`/`psmoke:` label rituals to
authorize credentialed runs on pull requests, and a runbook describing a process
a human had to perform. `scripts/vercel/promote-image.mjs` carried 80 lines of
regex surgery against TypeScript source purely to write that constant.

This is a single-maintainer open-source project. The previous shape optimized
for a reviewed hand-off between people who do not exist here, while the review
it produced was self-review.

## Alternatives rejected

- **Nightly pushes a pin commit to main.** No pull request, but automated
  commits race the maintainer's own pushes and keep a generated value in git.
- **Env override only.** A fresh clone could not use the Vercel provider at all
  until someone hand-fed it a digest.
- **Floating tag in released packages.** Removes the guarantee that a user runs
  the artifact the evidence proves.

## Consequences

- An image change is one pull request. A commit's code and its image always come
  from the same commit.
- Pin history moves out of `git log` into npm version history, the immutable
  `sha-<commit>` registry tags, and release notes. This is a real trade.
- Rollback changes shape: dispatch Release naming an earlier nightly rather than
  reverting a pin commit.
- The client no longer compares against a constant. Its invariant is now
  *"creation must use a fully-qualified digest"* — stronger, and free of globals.
- No workflow needs `contents: write` or `pull-requests: write`.

## Verification

- Precedence, cache behavior, override refusal against a release pin, and
  fail-closed handling of a malformed pin:
  [`tests/vercel-image-resolution.test.ts`](../../tests/vercel-image-resolution.test.ts).
- The emitter rejects unproven evidence and writes no pin when it does:
  [`tests/vercel-scripts.test.ts`](../../tests/vercel-scripts.test.ts).
- Workflow contracts — no promotion branch, no label ritual, no repository write
  permission, both smoke gates before a pin:
  [`tests/vercel-workflow.test.ts`](../../tests/vercel-workflow.test.ts).
- `npm run validate:release` fails closed when no pin was emitted.
