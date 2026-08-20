---
type: ADR
title: "Coding-agent version manifest"
description: "A single manifest declares the supported coding agents; the image derives from it and promotion is a reviewable pull request."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/12
---

# Coding-agent version manifest

## Decision

**`images/vercel/agents.json` is the single source of truth for the coding
agents in the Sandbox image.** It declares the supported agents (Pi, Claude
Code, Codex, OpenCode), their npm install sources, exact pinned versions, and
version-probe flags under an `exact-pin` policy.

- The **Dockerfile derives** its `npm install -g` pins and build-time version
  greps from the manifest with `jq`, so a partial update (Dockerfile bumped
  without the manifest) cannot be built at all.
- **`provenance.json` records the same versions** as reviewed evidence;
  `assert-agent-manifest.mjs` fails closed unless both agree, and the local
  image check plus the Sandbox smoke gate verify the exact installed versions
  inside the running image.
- **Promotion is a reviewable pull request, not a channel retag.** The daily
  **Agent refresh** workflow detects registry drift, applies it to the
  manifest + provenance, builds an immutable candidate, runs the publisher and
  consumer exact-digest smoke gates, and opens one reviewable promotion PR on
  the fixed `agent-update/agents` branch. Merging the PR is the human
  approval; the scheduled **Nightly** then builds that exact content and moves
  the `nightly` channel to the identical digest, so the digest a checkout
  follows is byte-identical to the one that was smoked.
- **A failed candidate never touches the pin.** The refresh workflow has no
  channel-tag or pin-writing step; failure leaves the production image
  untouched and reports the failing gate.

## Context

Issue [#12](https://github.com/gannonh/devbox/issues/12) (approved) required a
declared source of truth for agent versions, scheduled + manual update
detection, immutable candidate builds, exact-digest validation, and a
reviewable promotion artifact, with rollback and documentation. The agent
versions previously lived only as literals in the Dockerfile and as records in
`provenance.json`, with no detection loop, so a fresh Sandbox could lag behind
the host's agents for weeks.

Two directions were possible: keep literal Dockerfile pins and enforce
agreement with the manifest by contract tests, or derive the Dockerfile from
the manifest so disagreement is impossible by construction. Derivation was
chosen: it removes a drift surface instead of policing it, and the manifest
stays the single place a version is declared. This preserves ADR
[0004](0004-image-pin-as-build-output.md): nothing in git carries an image
digest; the promotion PR changes the *version source*, and the digest follows
as a build output.

## Consequences

- Adding or removing a supported agent is a one-file manifest change plus the
  matching provenance record; the Dockerfile, local image check, and smoke
  gate adapt automatically.
- An agent update is a single PR whose body records the declared → candidate
  versions, the validated candidate digest, and the smoke evidence URLs.
- Rollback is a revert of the merged version PR — the next scheduled Nightly
  rebuilds the previous declared versions — or a Release naming an earlier
  known-good nightly, which reuses that nightly's existing image and source
  digest without rebuilding.
- The scheduled refresh opens at most one open promotion PR at a time and
  skips rebuilds when that PR already carries the exact current drift.
- Daily cadence (04:00 UTC) bounds the detection-to-merge lag; manual dispatch
  with an `--agents` filter forces an urgent refresh of a subset.
