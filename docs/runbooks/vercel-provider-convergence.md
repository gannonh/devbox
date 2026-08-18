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

The `Vercel provider UAT` workflow is manual on the default branch or called by
the release workflow. It is serialized and requires the consumer Vercel triad,
a private fixture repository, and the fixture Electron/Vite/OAuth contract.
The run must prove private clone, branch creation, interactive terminal,
Pi/Claude/Codex/OpenCode, authenticated noVNC HTTP and WebSocket access,
Chromium localhost OAuth, Electron/Vite, authenticated push, stop/resume with
secret refresh, and remove.

The protected environment supplies `DEVBOX_UAT_PUSH_TOKEN`,
`DEVBOX_UAT_ENV_CONTENT`, `DEVBOX_UAT_FIXTURE_COMMAND`, and
`DEVBOX_UAT_RESUME_COMMAND`. The fixture command is responsible for starting
its Vite and Electron entry points, opening its localhost OAuth URL with
Chromium, checking all four agent executables, and pushing the run-unique
branch in the missing-branch path. It must print these exact standalone
markers only after each action succeeds: `DEVBOX_UAT:agents`,
`DEVBOX_UAT:chromium-oauth`, `DEVBOX_UAT:electron-vite`, and
`DEVBOX_UAT:push`. The resume command must refresh runtime secrets and print
`DEVBOX_UAT:resume-secret-refresh`. The provider records each marker as an
independent check; command output and credentials are not evidence.

Every evidence directory is redacted before upload. Search artifacts for the
fixture token, Vercel token, Basic Auth password, `.env` values, URLs with
credentials, port `5900`, and residual resource IDs. Any match fails the run.

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
