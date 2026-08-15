---
type: Runbook
title: Vercel image supply chain
status: Build implementation ready
issue: https://github.com/gannonh/devbox/issues/4
---

# Vercel image supply chain

This runbook operates the digest-pinned Vercel Sandbox image described by
[issue #4](https://github.com/gannonh/devbox/issues/4) and the
[image-promotion ADR](../adrs/0001-vercel-image-promotion.md). The checked-in
pin in [`src/providers/vercel/image.ts`](../../src/providers/vercel/image.ts)
is deliberately release-invalid until the secret-gated workflow has produced
and independently smoked a public candidate; the workflow then opens a
reviewed PR that replaces the bootstrap metadata.

## One-time publisher setup

1. Create or select a dedicated Vercel **publisher project** and team. The VCR
   repository belongs to that project; use a stable repository name such as
   `devbox`.
2. Create the repository with `vercel vcr add devbox --project <project-id> --scope <team-slug>` (or
   the Vercel dashboard). Mark it public once, as an explicit operator action:
   `vercel vcr config devbox --project <project-id> --scope <team-slug> --public true`.
3. Verify with the audited CLI version contract (`vercel@58.11.0`) and an explicit team scope:
   `vercel vcr inspect devbox --project <project-id> --scope <team-slug> --format json`.
   The flat repository response is correlated by repository `id`, `name`, and
   `projectId`; public visibility accepts boolean/string `true` or `public`.
   Separately run scoped `vercel project list --scope <team-slug> --format json`
   and `vercel teams list --scope <team-slug> --format json` to correlate project `accountId` and
   team `id`/`slug`; the workflow never changes visibility silently.
4. Store publisher credentials in GitHub Actions secrets:
   `VERCEL_PUBLISHER_TOKEN`, `VERCEL_PUBLISHER_TEAM_ID`,
   `VERCEL_PUBLISHER_PROJECT_ID`, `VERCEL_PUBLISHER_TEAM_SLUG`, and
   `VERCEL_PUBLISHER_PROJECT_SLUG`. Use a token scoped only to the publisher
   project/team and rotate it by replacing the secret, then rerun the smoke
   workflow.
5. Configure a **different consumer project or team** with independently
   scoped `VERCEL_CONSUMER_TOKEN`, `VERCEL_CONSUMER_TEAM_ID`,
   `VERCEL_CONSUMER_PROJECT_ID`, `VERCEL_CONSUMER_TEAM_SLUG`, and
   `VERCEL_CONSUMER_PROJECT_SLUG` secrets. The consumer token must not be the
   publisher token. The consumer project needs Sandbox enabled but does not
   need registry write access.
6. Rotate consumer credentials independently: create a replacement token scoped
   only to the consumer project/team, update all five `VERCEL_CONSUMER_*`
   secrets together if the project or team changes, then revoke the old token.
   Rerun the workflow and require its consumer project/team identity check and
   exact-digest smoke evidence to pass before considering the rotation valid;
   never compare or paste token values into logs.

No token, password, source repository, or `.env` file belongs in the image
context, Dockerfile, checked-in pin, or workflow output.

## Image assets and local reproduction

`images/vercel/provenance.json` is the source of truth for the mirrored Universal
inputs: the audited upstream repository and `UPSTREAM_COMMIT`, hashes of the
upstream Ubuntu and Universal Dockerfiles, digest-pinned Ubuntu/Bun bases, the
Node archive checksum, dated apt snapshot, and exact runtime package versions.
The managed VMI digest and version inventory are parity evidence only; Docker
never attempts to pull the managed VMI.

`images/vercel/Dockerfile` reproduces that reviewed upstream recipe, then adds
Chromium, Xvfb, fluxbox, x11vnc, noVNC/websockify, and the Basic Auth proxy.
`start-devbox.sh` starts every service explicitly; the image clears its inherited
shell command with an empty `CMD []`, so no runtime behavior depends on Docker
defaults. `status-devbox.sh` and `check-local-image.sh` verify the non-root user,
passwordless sudo, tools, display binaries, and empty runtime defaults.

Build and inspect the exact checked-in provenance locally:

```sh
docker buildx build \
  --platform linux/amd64 \
  --load -t devbox-vercel:local images/vercel
images/vercel/check-local-image.sh devbox-vercel:local
```

Use a throwaway runtime password and keep the container alive while checking the
explicit startup path:

```sh
docker run --rm -e DEVBOX_NOVNC_PASSWORD='local-only' devbox-vercel:local \
  sh -c '/usr/local/bin/devbox-start && exec sleep infinity'
```

To update Universal, fetch the proposed upstream commit, hash its
`images/ubuntu/Dockerfile` and `images/universal/Dockerfile`, review recipe
changes, then update every affected digest, checksum, version, and snapshot in
`provenance.json` and the Dockerfile together. A reviewed provenance update must
pass the local image check and both real Sandbox smoke gates; never update only
the commit or restore floating inputs.

## Candidate, readiness, and smoke workflow

Run **Actions → Vercel image supply chain → Run workflow** for a manual
candidate. Before the workflow lands on the default branch, a maintainer may
label a same-repository PR `vercel-image-candidate`; CI then calls the same
secret-gated workflow with read-only repository permissions and promotion
creation disabled. Fork PRs and unlabeled PRs cannot receive this credentialed
job. The workflow validates `provenance.json`, fetches the exact
`UPSTREAM_COMMIT`, and verifies both recorded upstream Dockerfile hashes before
building. The nightly schedule compares upstream HEAD with `UPSTREAM_COMMIT`.
Unchanged provenance skips cleanly; drift fails closed with
`upstream-drift.json` and requires a reviewed provenance update before the
normal candidate, smoke, and promotion path can run. It never builds floating
upstream state, auto-merges, or releases.

The candidate job has a 45-minute GitHub Actions timeout. It gives each HTTP
request 10 seconds, ordinary SDK calls 30 seconds, commands 60 seconds, each
smoke gate 10 minutes, deletion verification 30 seconds, and cleanup 2
minutes; these `SMOKE_*` bounds are intentionally explicit and should only be
changed with a reviewed contract update.

The workflow serializes candidate runs with a non-canceling concurrency group.
The candidate tag includes the devbox source commit, upstream recipe commit, and Ubuntu base digest prefix; an
existing tag is reused only after its `manifestDigest` matches the inspected
candidate digest, and a mismatch fails closed. Promotion reuses an existing
open branch PR instead of creating duplicate proposals; closed or merged PRs
are not treated as reusable.

The workflow:

1. Installs the audited `vercel@58.11.0` CLI, then logs Buildx into VCR
   through `--password-stdin`, builds the immutable
   `sha-<commit>-<upstream-commit>-<ubuntu-digest>` tag for `linux/amd64` with zstd, and resolves
   its manifest digest.
2. Verifies the flat publisher repository response with an explicit
   `--scope <publisher-team-slug>`, then correlates the publisher project/team
   through scoped project/team responses without unioning unrelated objects;
   the independent consumer project/team is checked with the consumer token.
3. Polls VCR with the explicit publisher team scope and a bounded deadline.
   `Preparing` and `image_not_ready` are
   transient observations; `Unoptimized`, authentication failures, and a
   timeout fail with an actionable message and preserved evidence.
4. Creates a real publisher Sandbox from the exact fully-qualified VCR digest.
   The smoke boundary rejects tags, bare names, and other registries before an
   API call. It starts `/usr/local/bin/devbox-start` explicitly, checks
   identity, sudo, bounded executable version probes for all agents/runtimes,
   `gh`/Chromium/display tools, and the auth proxy, then probes authenticated
   noVNC HTTP/WebSocket access and a terminal command. Each HTTP request has a
   ten-second abortable deadline; SDK operations and the whole smoke have
   bounded deadlines, with cleanup using its own hard deadline.
5. Stops or aborts the Sandbox, enumerates every VM session, requires terminal
   `stopped`/`aborted` states, verifies deletion with repeated non-resuming
   lookups, and treats eventual `running`/`stopping` responses as transient:
   it attempts another stop/delete, re-enumerates sessions, and performs a
   final bounded cleanup attempt before failing closed. Snapshot listings are
   plain metadata, so cleanup resolves each `id` with `Snapshot.get` before
   bounded instance deletion and records that metadata `id` in evidence. After
   a lost create handle, owned name/tag discovery and snapshot listings poll
   through the independent cleanup deadline; collection 404s are errors, not
   empty results. A fresh final owned Sandbox listing must omit the exact
   recovered name, and the final snapshot listing is authoritative: every
   matching item must be absent or `deleted`; recoverable intermediate errors
   are cleared only after that convergence, otherwise residual IDs/statuses are
   recorded and the gate fails closed.
6. Repeats creation and cleanup with the independent consumer credentials.
   The consumer uses the same public digest and fails if its token is empty,
   reused, or its team/project scope matches the publisher pair.
7. After both gates pass, the promotion helper consumes the redacted reports
   and rejects mismatched digests/scopes, failed checks, non-terminal sessions,
   unsuccessful deletion, missing final owned-resource convergence, or residual
   snapshots before updating the sole image pin. The PR is reviewed and merged by an operator; the candidate workflow
   cannot auto-merge or release it.

Artifacts are written under the workflow evidence directory and uploaded only
after the final `scripts/vercel/redact-artifacts.mjs` step succeeds; a redaction
failure removes/withholds the directory. Reports retain readiness states,
structured build/manifest/readiness/startup/HTTP/WebSocket/terminal/stop/delete
timings, selected digests, session states, snapshot statuses, and cleanup
recovery evidence without credential values. Promotion requires every named
smoke check, the exact smoke URL, nonempty IDs, HTTPS noVNC URLs, ordered ISO
stage/aggregate timestamps with sane durations, valid cleanup-error arrays,
and complete identity/cleanup fields.

## Pin validation and release

After merging a promotion PR, run:

```sh
npm run typecheck
npm run lint
npm run build
npm test
npm run validate:release
```

Release validation rejects floating tags, bare project-relative references,
malformed digests, malformed team/project slugs, publisher metadata that does
not match the parsed image reference, missing smoke evidence, a mismatched
tested reference, and a consumer scope that was not independently proven. A
package release must therefore use the reviewed pin; a failed or
publisher-only candidate cannot update it.

## Rollback

Rollback is a normal reviewed source change: restore a previously tested
`VERCEL_IMAGE_REFERENCE`, its matching provenance/evidence metadata, and publish the
package through the normal release process. Do not retag a digest or edit a
registry image in place. Existing **named Sandboxes retain their creation
image** until they are removed; delete and recreate a named Sandbox to pick up
the rollback (or any later image pin).

## Orphan cleanup

A failed smoke run attempts cleanup in `finally`, but operators should inspect
for leftovers with the matching publisher or consumer project credentials.
The CLI is pinned to the audited version used by CI:

```sh
export VERCEL_TOKEN='...' # shell environment only; never paste into logs
export VERCEL_TEAM_ID='<team-id>'
export VERCEL_PROJECT_ID='<project-id>'
export VERCEL_TEAM_SLUG='<team-slug>'
export OWNED_SMOKE_TAG='<devbox-run-tag-from-report>'
export OWNED_SMOKE_NAME='<exact-name-from-report>'

# Publisher-owned smoke resources.
npx vercel@58.11.0 sandbox list --all \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}" \
  --name-prefix 'devbox-smoke-publisher-' \
  --tag "devbox-run=${OWNED_SMOKE_TAG}"
npx vercel@58.11.0 sandbox snapshots list \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}" \
  --name "${OWNED_SMOKE_NAME}"

# Consumer-owned smoke resources: repeat with consumer credentials and report tag/name.
# --name-prefix 'devbox-smoke-consumer-' --tag "devbox-run=${OWNED_SMOKE_TAG}"
npx vercel@58.11.0 sandbox list --all \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}" \
  --name-prefix 'devbox-smoke-consumer-' \
  --tag "devbox-run=${OWNED_SMOKE_TAG}"
npx vercel@58.11.0 sandbox snapshots list \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}" \
  --name "${OWNED_SMOKE_NAME}"

# Delete only IDs/names confirmed by the matching report and listing.
npx vercel@58.11.0 sandbox snapshots delete '<snapshot-id-from-list>' \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}"
npx vercel@58.11.0 sandbox remove "${OWNED_SMOKE_NAME}" \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}"
```

Review the uploaded `provenance.json`, `publisher-smoke.json`, and `consumer-smoke.json`. Use the matching token/team/project scope
and the unique `devbox-run` tag recorded in each report; delete only matching
publisher, consumer, or resolver Sandboxes and snapshot IDs, never named user
workspaces. Re-run the workflow after cleanup and confirm every matching
snapshot is absent or explicitly `deleted`.
