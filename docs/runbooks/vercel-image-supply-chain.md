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
2. Create the repository with `vercel vcr add devbox --project <project>` (or
   the Vercel dashboard). Mark it public once, as an explicit operator action:
   `vercel vcr config devbox --project <project> --public true`.
3. Verify with `vercel vcr inspect devbox --project <project> --format json`.
   The workflow only verifies that visibility is public; it never changes
   visibility silently.
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

No token, password, source repository, or `.env` file belongs in the image
context, Dockerfile, checked-in pin, or workflow output.

## Image assets and local reproduction

`images/vercel/` contains the focused Dockerfile and explicit runtime assets:

- `Dockerfile` starts from `vcr.vercel.com/vercel/sandbox/universal` with a
  required manifest digest build argument and adds Chromium, Xvfb, fluxbox,
  x11vnc, noVNC/websockify, and the Basic Auth HTTP/WebSocket proxy.
- `start-devbox.sh` starts every process explicitly and requires the runtime
  `DEVBOX_NOVNC_PASSWORD`; it is not an image `ENTRYPOINT` or `CMD`.
- `status-devbox.sh` checks the non-root identity, passwordless sudo, all four
  agents, Node.js/Bun/Python/Chromium, and display/proxy binaries.
- `check-local-image.sh` inspects `Config.User`, `Config.Entrypoint`, and
  `Config.Cmd`, then runs the status check with an explicit command.

Resolve a base digest with a scoped Vercel credential, then build locally:

```sh
export VERCEL_TOKEN=... # shell environment only; never paste into logs
export VERCEL_TEAM_ID=...
export VERCEL_PROJECT_ID=...
export BASE_DIGEST_EVIDENCE="$PWD/.vercel-image-evidence/base.json"
base_digest="$(node scripts/vercel/resolve-universal-digest.mjs)"
docker buildx build \
  --platform linux/amd64 \
  --build-arg "UNIVERSAL_BASE_DIGEST=${base_digest#sha256:}" \
  --load -t devbox-vercel:local images/vercel
images/vercel/check-local-image.sh devbox-vercel:local
```

The promoted artifact uses the same `linux/amd64` Buildx output with zstd
compression. Use a throwaway runtime password to exercise the explicit start:

```sh
docker run --rm -e DEVBOX_NOVNC_PASSWORD='local-only' devbox-vercel:local \
  /usr/local/bin/devbox-start
```

## Candidate, readiness, and smoke workflow

Run **Actions → Vercel image supply chain → Run workflow** for a manual
candidate, optionally supplying a full `sha256:<64 hex>` Universal digest.
The nightly schedule resolves the current Universal digest by creating a
short-lived Sandbox, compares it with the checked-in base digest, and skips
unchanged runs. A changed digest follows exactly the same path and never
merges a PR automatically.

The workflow:

1. Logs Buildx into VCR through `--password-stdin`, builds the immutable
   `sha-<commit>` tag for `linux/amd64` with zstd, and resolves its manifest
   digest.
2. Verifies the publisher repository is public without changing visibility.
3. Polls VCR with a bounded deadline. `Preparing` and `image_not_ready` are
   transient observations; `Unoptimized`, authentication failures, and a
   timeout fail with an actionable message and preserved evidence.
4. Creates a real publisher Sandbox from the exact fully-qualified digest.
   The smoke starts `/usr/local/bin/devbox-start` explicitly, checks identity,
   sudo, all agents, Chromium, display processes, authenticated noVNC HTTP and
   WebSocket access, and a terminal command.
5. Stops and deletes the Sandbox, records terminal session states, and checks
   snapshots for absent/deleted status with no non-deleted residual.
6. Repeats creation and cleanup with the independent consumer credentials.
   The consumer uses the same public digest and fails if its team/project pair
   is identical to the publisher pair.
7. After both gates pass, opens a promotion PR updating the sole image pin with
   the candidate digest, base digest, source commit, and separate publisher
   and consumer smoke URLs. The PR is reviewed and merged by an operator; the
   candidate workflow cannot auto-merge or release it.

Artifacts are written under the workflow evidence directory and uploaded only
after `scripts/vercel/redact-artifacts.mjs` traverses them. Reports retain
readiness states, stage timings, selected digests, session states, snapshot
statuses, and cleanup evidence without credential values.

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
malformed digests, missing smoke evidence, a mismatched tested reference, and
a consumer scope that was not independently proven. A package release must
therefore use the reviewed pin; a failed or publisher-only candidate cannot
update it.

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
npx sandbox list --project <project-id>
npx sandbox snapshots --project <project-id>
npx sandbox remove <sandbox-name> --project <project-id>
```

Review the uploaded `publisher-smoke.json` and `consumer-smoke.json` first.
Delete only matching `devbox-image` smoke Sandboxes and snapshots; do not
remove named user workspaces. Re-run the workflow after cleanup and confirm
there is no non-deleted matching snapshot.
