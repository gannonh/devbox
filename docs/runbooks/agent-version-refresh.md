---
type: Runbook
title: Coding-agent version refresh
status: Build implementation ready
issue: https://github.com/gannonh/devbox/issues/12
---

# Coding-agent version refresh

This runbook operates the automated refresh described by
[issue #12](https://github.com/gannonh/devbox/issues/12) and
[ADR 0006](../adrs/0006-agent-version-manifest.md): keeping the coding agents
in the Sandbox image (Pi, Claude Code, Codex, OpenCode) current through a
reproducible, reviewable image-refresh process.

## The manifest

[`images/vercel/agents.json`](../../images/vercel/agents.json) is the single
source of truth for the supported agents: npm install sources, binaries,
exact pinned versions, and version-probe flags, under an `exact-pin` policy.

- The **Dockerfile derives** its install pins and build-time version greps
  from the manifest, so a partial update cannot be built.
- **`provenance.json`** records the same versions as reviewed evidence.
  `node scripts/vercel/assert-agent-manifest.mjs` fails closed unless both
  agree; `node scripts/vercel/check-agent-updates.mjs` compares the manifest
  against the npm registry and prints a drift report.
- The **local image check** (`images/vercel/check-local-image.sh`) and the
  **Sandbox smoke gate** verify the exact installed versions inside the
  running image, plus non-root identity, provenance, and the display/security
  boundaries.

To add or remove a supported agent, edit `agents.json` and the matching
version records in `provenance.json` in one commit; the Dockerfile, status
check, and smoke gate adapt automatically.

## Cadence

The **Agent refresh** workflow (`.github/workflows/agent-refresh.yml`) runs
**daily at 04:00 UTC** (after the Nightly build) and by manual dispatch:

1. **Detect** (credential-free): resolves the registry latest for every
   declared agent. No drift → the workflow ends green; nothing is built and no
   write-capable token was minted.
2. **Apply**: bumps `agents.json` and syncs the `provenance.json` version
   records, then asserts the manifest contract.
3. **Build**: one immutable `linux/amd64` zstd candidate image on a
   never-reused `agent-<content-tree>-...` tag, with the reviewed provenance,
   zstd manifest, digest, and VCR-readiness checks from the Nightly pipeline.
4. **Validate**: the publisher and consumer Sandbox smoke gates run against
   the exact candidate digest, asserting every declared agent's installed
   version, non-root availability, image provenance, and the existing
   display/security boundaries, including startup and cleanup verification.
5. **Promote**: a fully validated candidate is committed to the fixed
   `agent-update/agents` branch and a reviewable **pull request** is opened
   (or the existing open one updated). The PR body records the declared →
   candidate versions, the candidate digest, and the validation evidence.

If an open promotion PR already carries exactly the drift this run would
produce, the rebuild is skipped — at most one open promotion PR exists.

## Approval and promotion

The PR is the reviewable promotion artifact. **Merging it is the human
approval.** The scheduled **Nightly** then builds that exact image content
and moves the `nightly` channel to the identical digest (content-addressed
builds make the merged digest byte-identical to the one that was smoked);
the nightly's own publisher/consumer gates re-prove it before the channel
moves. The refresh workflow itself never retags a channel and never writes a
pin, so **a failed candidate leaves the production image untouched** and the
run reports the failing gate with the redacted evidence artifact
(`vercel-agent-refresh-evidence-<run-id>`).

Pull requests never receive cloud credentials: the promotion PR's CI is the
credential-free lint/typecheck/build/test gate only.

## Urgent refresh

Dispatch **Agent refresh** manually from the default branch as the repository
owner. Use the `agents` input to refresh a subset, e.g. `pi,claude`. If an
open promotion PR already exists for the other agents, it is updated
in place; otherwise a new PR is opened.

## Release-source failures

If the npm registry is unreachable or returns a malformed version, the detect
step fails closed with the failing source named, the current pin is
untouched, and no PR is opened. A breaking agent release can never reach the
image without a passing candidate smoke and a human merge.

## Rollback

Two paths, both without rebuilding the image:

1. **Revert the promotion PR** (`git revert` of the merged commit). The next
   scheduled Nightly builds the previous declared versions and moves the
   `nightly` channel back to that digest.
2. **Release an earlier nightly**: dispatch **Release** naming a known-good
   older nightly prerelease. It re-resolves that pin and moves `stable` back
   to the digest it already proved.

For an immediate stop without waiting for gates, repoint the npm dist-tag
(`npm dist-tag add @gannonh/devbox@<previous-good-version> latest`) and follow
up with a Release run so the `stable` image channel and `latest` agree.

## Local checks

```sh
node scripts/vercel/check-agent-updates.mjs          # drift report (JSON)
node scripts/vercel/assert-agent-manifest.mjs        # manifest ↔ provenance contract
node scripts/vercel/check-agent-updates.mjs --agents pi,claude --out /tmp/drift.json
node scripts/vercel/apply-agent-updates.mjs --report /tmp/drift.json --dry-run
```

`apply-agent-updates.mjs` refuses unknown agents and non-upgrade versions, and
writes deterministically so a rerun of the workflow against the same drift is
a no-op.
