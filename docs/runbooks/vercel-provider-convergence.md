---
type: Runbook
title: "Vercel provider convergence"
description: "Reproduce the secret-gated UAT and five-launch readiness benchmark."
status: Current
issue: https://github.com/gannonh/devbox/issues/7
---

# Vercel provider convergence

## Local gates

```sh
npm run typecheck
npm run lint
npm run build
npm test
npm run validate:release
npm run benchmark:vercel -- --help
```

The package gate rejects floating, bare, deprecated, untested, or
cross-project-unproven image references. The checked-in pin must remain a
fully-qualified `vcr.vercel.com/<team>/<project>/<repository>@sha256:<digest>`
reference with independent publisher and consumer smoke evidence.

## Five-run benchmark

Run from a clean checkout with warm Vercel auth and the promoted image already
`Ready`. Load credentials only in the child shell; never put them in argv:

```sh
(set -a; . "$PWD/.env"; set +a; npm run benchmark:vercel -- \
  --report uat-evidence/vercel-benchmark-$(date -u +%Y%m%dT%H%M%SZ))
```

The command creates five fresh names, records command start, create/resume,
source, runtime secret sync, display/auth, port, terminal, setup, stop, and
cleanup timings, and writes `vercel-benchmark.json` plus
`vercel-benchmark.md`. It reports
all five command-to-ready values, median, environment/project plan, vCPU,
image digest, source commit, region, outliers, and residual resources. A
failed run, residual resource, or median over `10000ms` exits nonzero.

## Credentialed UAT

The `Vercel provider UAT` workflow is called by the release workflow after the
provider terminal smoke, or dispatched manually on the default branch with the
image reference to exercise. Pull requests never reach it. It is serialized and
requires the consumer Vercel triad, a private fixture repository, and the
fixture Electron/Vite/OAuth contract plus the relay-backed app-route fixture.
The run must prove private clone, branch creation, interactive terminal,
Pi/Claude/Codex/OpenCode, authenticated noVNC HTTP and WebSocket access,
Chromium localhost OAuth, Electron/Vite, authenticated push, stop/resume with
secret refresh, and remove.

The workflow reuses the existing `vercel-provider-smoke` environment and the
same `DEVBOX_GITHUB_FIXTURE_TOKEN` for clone, authenticated push, and
run-unique branch deletion. The checked-in `scripts/vercel/uat-fixture.mjs`
is uploaded into the disposable Sandbox and installs pinned Vite/Electron
dependencies in a temporary workspace. It starts the image display, checks all
four agent executables, opens localhost OAuth with Chromium, loads the same app
in Electron, pushes a generated marker, and verifies the remote branch. After
resume, it verifies the branch and a newly generated runtime secret marker.
The provider records these exact standalone markers only after each action
succeeds: `DEVBOX_UAT:agents`, `DEVBOX_UAT:chromium-oauth`,
`DEVBOX_UAT:electron-vite`, `DEVBOX_UAT:push`, and
`DEVBOX_UAT:resume-secret-refresh`. The runner and its temporary workspace are
removed before the Sandbox path is cleaned up; command output and credentials
are not evidence.

Every evidence directory is redacted before upload. Search artifacts for the
fixture token, Vercel token, display access code (`token=` or
`devbox_novnc=`), `.env` values, URLs with
credentials, port `5900`, and residual resource IDs. Any match fails the run.

## Relay-backed app-route UAT

`scripts/vercel/app-port-uat.mjs` proves the relay-backed public app-route path
from [#17](https://github.com/gannonh/devbox/issues/17) against real
infrastructure. It drives production CLI dispatch — real credentials, source,
image, lifecycle, runtime sync, detector, prompt, relay manager, port update,
and metadata — and injects only the terminal adapter, so the run needs no PTY.

The default scenario clones `gannonh/uat-devbox` at
`180442037b52775618b2d56cdf7f218514aa9b00` on `main`. That pinned commit is a
pnpm monorepo whose `apps/web` member runs the ordinary `pnpm --filter web dev`
command and contains the initial browser marker. It has no
`.devcontainer/devcontainer.json`, `server.allowedHosts`, or `--host` flag.
Routes point at the Sandbox-local relay, which presents the app a `Host` of
`localhost:<port>` (ADR 0007).

```bash
(set -a; . "$PWD/.env"; set +a; \
  VERCEL_TOKEN="$VERCEL_CONSUMER_TOKEN" \
  VERCEL_TEAM_ID="$VERCEL_CONSUMER_TEAM_ID" \
  VERCEL_PROJECT_ID="$VERCEL_CONSUMER_PROJECT_ID" \
  DEVBOX_UAT_REPO_ROOT=<clone of the fixture repo> \
  DEVBOX_UAT_REPORT=<path>.json \
  node scripts/vercel/app-port-uat.mjs)
```

`DEVBOX_UAT_ONLY=monorepo|vite|next|both` selects a scenario. Each phase asserts
before it records, so a green run is proof rather than a transcript: the
candidate is offered, the fresh Sandbox exposes `6080` only, the route set
changes without changing Sandbox identity, the public route returns the fixture
marker, `--url` labels the logical app port and `6080` as noVNC, a real browser
observes HMR without a navigation or URL change, same-Sandbox attach reuses the
transport, the live port-limit boundary is measured, the injected
metadata-commit failure leaves a reconcilable pending record, snapshot resume
reconstructs the mapping, changed selection refreshes it, and removal leaves no
Sandbox, no non-deleted snapshot, and no local metadata.

The `port-limit-boundary` phase measures the service maximum rather than
trusting a declaration. Reproduce it alone if the API changes: it should accept
14 total ports, fail 15 with a 500, and reject 16 with
`` `ports` should NOT have more than 15 items ``.

Two environment notes. Git's system config may pin a GUI credential helper,
which blocks forever without a desktop session; the script disables the helper
for its own child processes because the provider supplies the token through
`GIT_ASKPASS`. And a port update regenerates every route subdomain, so re-read
routes after an update rather than reusing a URL captured before it.

## Incident cleanup

If a run fails, first inspect the redacted report and list only resources with
the run's exact name/tag prefix. Do not use broad `--rm` commands. Verify all
sessions are terminal before deleting each Sandbox; delete snapshots
separately and relist until absent or `deleted`. If cleanup is partial, leave
the `0600` residual metadata in place and retry with the same identity. Remove
the metadata only after the final listing proves no residual resource.

Official references: [Sandbox concepts](https://vercel.com/docs/sandbox/concepts),
[persistent Sandboxes](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes),
[authentication](https://vercel.com/docs/sandbox/concepts/authentication),
[images](https://vercel.com/docs/sandbox/concepts/images), and
[pricing](https://vercel.com/docs/sandbox/pricing).
