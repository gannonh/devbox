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

## Issue #5: real provider terminal smoke

Run **Actions → Vercel provider terminal smoke → Run workflow** manually from
the repository owner's account, on the default branch. Select `both` for the
normal gate, or select `existing`/`missing` while diagnosing one deterministic
source path. This workflow is separate from the image candidate workflow and
has no `pull_request` trigger. Its job guard rejects fork/untrusted or
non-default-branch dispatches, grants only `contents: read`, serializes runs,
and has a 30-minute job timeout.

Create these exact repository secrets:

| Secret | Contract |
| --- | --- |
| `VERCEL_TOKEN` | Least-privilege token for the Sandbox project |
| `VERCEL_TEAM_ID` | Exact Vercel team/account ID for that token |
| `VERCEL_PROJECT_ID` | Exact Vercel project ID for that token |
| `GITHUB_FIXTURE_TOKEN` | Read-only token able to clone the private fixture |
| `GITHUB_FIXTURE_REPOSITORY` | Exact `owner/repository` pair |
| `GITHUB_FIXTURE_BRANCH` | Branch expected to exist for the existing path |
| `GITHUB_FIXTURE_DEFAULT_BRANCH` | Expected GitHub API default branch |
| `GITHUB_FIXTURE_EXPECTED_FILE` | Safe relative POSIX path to assert after clone |
| `GITHUB_FIXTURE_EXPECTED_CONTENT` | Exact expected file bytes (multiline allowed) |

The script builds the checked-in production adapters and rejects
`VERCEL_IMAGE_PIN` before reading the cloud configuration if its digest,
provenance, or promotion evidence is still zero/pending. This checkout has
that intentional bootstrap pin, so a run currently produces a blocked/not-run
report and must not be described as real provider evidence until a reviewed
image promotion replaces the pin.

After the pin is promoted, the gate validates that the fixture is private, the
API `full_name` and default branch match, and the requested branch has the
expected existence. It passes the private Git source to the stable
`@vercel/sandbox` v3 production client; it does not invoke `vercel`, `gh`, or a
host shell-out. The existing path clones `GITHUB_FIXTURE_BRANCH`. The missing
path verifies a run-unique branch is absent, clones the expected default, and
creates that branch inside the Sandbox without pushing it. Both paths assert
`origin`, commit `HEAD`, checked-out branch, clean status, and configured file
content. The production terminal adapter calls `openInteractive`, executes a
command, sends Ctrl-C through the terminal protocol, exits, stops for snapshot
completion, resumes/reconnects, and repeats terminal coverage. Final session
listing must show every created VM as `stopped` or `aborted`.

Cleanup is unconditional. The gate removes the run-unique Sandbox through the
production cleanup adapter, resolves paginated snapshot metadata through
`Snapshot.get` before deletion, re-lists until each matching snapshot is
absent or explicitly `deleted`, and rejects every non-deleted residual. It also
runs the existing owned-resource recovery helper by exact name/tag/scope so a
lost create response is not treated as success. Evidence records the run
identity, scope IDs, statuses, timings, checks, recovery history, and final
residuals; it never records either token, source password, interactive token,
or expected secret values. The workflow redacts all files immediately before
upload and withholds the directory if redaction itself fails.

If cleanup reports an ambiguous duplicate, do not blindly retry `--rm` or
choose a name from a broad list. Use the matching team/project in the Vercel
console, or manually identify and remove only the exact run-unique name/tags;
then rerun the workflow. This is a manual recovery path, not permission to
delete an unrelated user Sandbox. First-use device authentication remains under
the repository scope lock: concurrent first-use commands serialize scope
confirmation and persistence, while later branch operations release the lock
before attaching the terminal.

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
   Separately run scoped `vercel api "/v9/projects/<project-id>" --scope
   <team-slug> --raw` and `vercel teams list --scope <team-slug> --format json`
   to correlate project `accountId` and team `id`/`slug`; the workflow never
   changes visibility silently.
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
candidate only as the repository owner and only against the default branch.
Before the workflow lands on the default branch, the repository owner may
authorize one reviewed same-repository PR commit by creating and applying the
exact label `vcr:<40-character-head-SHA>`:

```bash
head_sha="$(gh pr view <number> --json headRefOid --jq .headRefOid)"
gh label create "vcr:${head_sha}" --color B60205 --description 'Authorize credentialed VCR verification for this exact SHA' --force
gh pr edit <number> --add-label "vcr:${head_sha}"
```

Only an owner-triggered `labeled` event whose payload head SHA exactly matches
that label starts the credentialed job. A later push is not authorized; create
and apply its new exact-SHA label after review. To rerun one SHA, remove and
reapply its label. The candidate job has read-only repository contents
permission and receives only the ten required publisher/consumer Vercel secrets.
All pull-request events are excluded from the separate write-capable promotion
job. Fork PRs and all other PR events cannot receive this credentialed job. The
workflow validates `provenance.json`, fetches the exact `UPSTREAM_COMMIT`, and
verifies both recorded upstream Dockerfile hashes before building. The nightly
schedule compares upstream HEAD with `UPSTREAM_COMMIT`.
Unchanged provenance skips cleanly; drift fails closed with
`upstream-drift.json` and requires a reviewed provenance update before the
normal candidate, smoke, and promotion path can run. It never builds floating
upstream state, auto-merges, or releases.

Every third-party action used by the credentialed workflow is pinned to a full
reviewed commit SHA. The candidate job has a 45-minute GitHub Actions timeout.
It gives each HTTP
request 10 seconds, ordinary SDK calls 30 seconds, commands 60 seconds, each
smoke gate 10 minutes, deletion verification 30 seconds, and cleanup 2
minutes; these `SMOKE_*` bounds are intentionally explicit and should only be
changed with a reviewed contract update.

The workflow serializes candidate runs with a non-canceling concurrency group.
Every run builds before smoke and publishes a never-reused candidate tag containing
the devbox source commit, upstream recipe commit, Ubuntu base digest prefix,
GitHub run ID, and run attempt. After smoke and redaction complete, a separate
write-capable job generates the pin from the verified source before inspecting
any remote promotion branch. It reuses an open promotion PR only when that
branch is exactly one commit rooted at the verified source and changes only the
identical generated pin. A closed branch causes a fresh run-suffixed proposal;
a pin already present on the selected source exits without pushing an
unpublished branch or attempting PR creation.

The workflow:

1. Installs the audited `vercel@58.11.0` CLI, then logs Buildx into VCR
   through `--password-stdin`, builds the immutable
   `sha-<commit>-<upstream-commit>-<ubuntu-digest>-<run-id>-<attempt>` tag as
   one `linux/amd64` manifest with zstd, and resolves its digest. It then
   inspects that exact digest as raw OCI JSON and fails unless every layer has
   media type `application/vnd.oci.image.layer.v1.tar+zstd`. The assertion also
   hashes the byte-exact raw response and requires it to equal the selected
   digest. Redaction refuses to upload that raw file if it contains credential
   material, but otherwise preserves its exact bytes; a redacted compression
   summary records the digest and layer descriptors. BuildKit's optional
   provenance attestation is disabled because its
   OCI index has no VCR readiness status; the checked-in, embedded,
   upstream-verified `provenance.json` and uploaded workflow artifact remain the
   reviewed provenance record.
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
7. After both gates pass, the isolated promotion job consumes the redacted
   reports and rejects mismatched digests/scopes, failed checks, non-terminal
   sessions, unsuccessful deletion, missing final owned-resource convergence,
   or residual snapshots before updating the sole image pin. It never executes
   scripts from a pre-existing promotion branch. The PR is reviewed and merged
   by an operator; the workflow cannot auto-merge or release it.

Artifacts are written under the workflow evidence directory and uploaded only
after the final `scripts/vercel/redact-artifacts.mjs` step succeeds; a redaction
failure removes/withholds the directory. Reports retain readiness states,
structured build/manifest/readiness/startup/HTTP/WebSocket/terminal/stop/delete
timings, selected digests, byte-exact credential-scanned raw OCI manifest and
zstd-layer proof, session states, snapshot statuses, and cleanup recovery
evidence without credential values. Promotion requires every named
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
