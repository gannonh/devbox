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

`images/vercel/` contains the focused Dockerfile and explicit runtime assets:

- `Dockerfile` starts from `vcr.vercel.com/vercel/sandbox/universal` with a
  required manifest digest build argument and adds Chromium, Xvfb, fluxbox,
  x11vnc, noVNC/websockify, and the Basic Auth HTTP/WebSocket proxy. Apt uses
  the reviewed dated `UBUNTU_SNAPSHOT` source, verifies an Ubuntu amd64 base,
  and disables floating archive/security indexes.
- `start-devbox.sh` starts every process explicitly and requires the runtime
  `DEVBOX_NOVNC_PASSWORD`; it is not an image `ENTRYPOINT` or `CMD`.
- `status-devbox.sh` checks the non-root identity and passwordless sudo, then
  runs bounded five-second `--version`/`-version` probes for all four agents,
  Node.js/Bun/Python/Chromium, `gh`, and the display/proxy binaries; runtime
  mode also exits nonzero unless Xvfb, fluxbox, x11vnc, websockify, and the auth
  proxy are all running.
- `check-local-image.sh` inspects `Config.User`, `Config.Entrypoint`, and
  `Config.Cmd`, then runs the status check with an explicit command.

Resolve a base digest with a scoped Vercel credential, then build locally:

```sh
export VERCEL_TOKEN=... # shell environment only; never paste into logs
export VERCEL_TEAM_ID=...
export VERCEL_PROJECT_ID=...
export VERCEL_PUBLISHER_TEAM_SLUG=...
# VCR CLI calls in CI also pass --scope "$VERCEL_PUBLISHER_TEAM_SLUG".
export BASE_DIGEST_EVIDENCE="$PWD/.vercel-image-evidence/base.json"
base_digest="$(node scripts/vercel/resolve-universal-digest.mjs)"
docker buildx build \
  --platform linux/amd64 \
  --build-arg "UNIVERSAL_BASE_DIGEST=${base_digest#sha256:}" \
  --load -t devbox-vercel:local images/vercel
images/vercel/check-local-image.sh devbox-vercel:local
```

The promoted artifact uses the same `linux/amd64` Buildx output with zstd
compression. To update the apt snapshot, first verify the pinned Universal
base's `/etc/os-release` codename and architecture, choose a dated snapshot
that contains the reviewed package set, update `UBUNTU_SNAPSHOT` and its
review date in the Dockerfile, then rerun the image asset, Buildx, smoke, and
release gates; never restore a moving archive URL. Use a throwaway runtime
password and keep the container alive
while inspecting the explicit start:

```sh
docker run --rm -e DEVBOX_NOVNC_PASSWORD='local-only' devbox-vercel:local \
  sh -c '/usr/local/bin/devbox-start && exec sleep infinity'
```

## Candidate, readiness, and smoke workflow

Run **Actions → Vercel image supply chain → Run workflow** for a manual
candidate, optionally supplying a full `sha256:<64 hex>` Universal digest.
The nightly schedule resolves the current Universal digest by creating a
short-lived Sandbox, compares it with the checked-in base digest, and skips
unchanged runs. A changed digest follows exactly the same path and never
merges a PR automatically.

The candidate job has a 45-minute GitHub Actions timeout. It gives each HTTP
request 10 seconds, ordinary SDK calls 30 seconds, commands 60 seconds, each
smoke gate 10 minutes, deletion verification 30 seconds, and cleanup 2
minutes; these `SMOKE_*` bounds are intentionally explicit and should only be
changed with a reviewed contract update.

The workflow serializes candidate runs with a non-canceling concurrency group.
The candidate tag includes both source commit and selected base digest; an
existing tag is reused only after its `manifestDigest` matches the inspected
candidate digest, and a mismatch fails closed. Promotion reuses an existing
branch/PR instead of creating duplicate proposals.

The workflow:

1. Installs the audited `vercel@58.11.0` CLI, then logs Buildx into VCR
   through `--password-stdin`, builds the immutable
   `sha-<commit>-<base-digest>` tag for `linux/amd64` with zstd, and resolves
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
   through the independent cleanup deadline; final snapshot cleanup requires
   every matching item to be absent or `deleted`, otherwise residual IDs/statuses
   are recorded and the gate fails closed.
6. Repeats creation and cleanup with the independent consumer credentials.
   The consumer uses the same public digest and fails if its token is empty,
   reused, or its team/project scope matches the publisher pair.
7. After both gates pass, the promotion helper consumes the redacted reports
   and rejects mismatched digests/scopes, failed checks, non-terminal sessions,
   unsuccessful deletion, or residual snapshots before updating the sole image
   pin. The PR is reviewed and merged by an operator; the candidate workflow
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
`VERCEL_IMAGE_REFERENCE`, its matching base/evidence metadata, and publish the
package through the normal release process. Do not retag a digest or edit a
registry image in place. Existing **named Sandboxes retain their creation
image** until they are removed; delete and recreate a named Sandbox to pick up
the rollback (or any later image pin).

## Orphan cleanup

A failed smoke run attempts cleanup in `finally`, but operators should inspect
for leftovers using the consumer or publisher project credentials:

```sh
export VERCEL_TOKEN='...' # shell environment only; never paste into logs
export VERCEL_TEAM_ID='<team-id>'
export VERCEL_PROJECT_ID='<project-id>'
export VERCEL_TEAM_SLUG='<team-slug>'
npx vercel sandbox list --all \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}" \
  --name-prefix 'devbox-smoke-publisher-' \
  --tag 'devbox-run=<owned-tag-from-report>'
npx vercel sandbox snapshots list \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}" \
  --name '<owned-smoke-sandbox-name>'
npx vercel sandbox remove '<owned-smoke-sandbox-name>' \
  --project "${VERCEL_PROJECT_ID}" --scope "${VERCEL_TEAM_SLUG}"
```

Review the uploaded `publisher-smoke.json` and `consumer-smoke.json` first.
Use the matching token/team/project scope and the unique `devbox-run` tag
recorded in the report; delete only matching smoke Sandboxes and snapshots,
never named user workspaces. Re-run the workflow after cleanup and confirm
there is no non-deleted matching snapshot.
