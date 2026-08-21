# Project Agent Instructions

## Vercel credentials and real UAT

- Devbox transfers dotenv values only when invoked with `devbox <branch> --env PATH`; `npm run worktree:setup` never copies or links environment files. Loading a file does **not** export variables into the caller's shell, so use an explicit child shell when needed. Never infer credential absence from bare `process.env` in a process that did not load the intended file.
- For local commands that need `.env`, load it only in the child shell and never print values or pass secrets in argv:
  ```bash
  (set -a; . "$PWD/.env"; set +a; <command>)
  ```
- The canonical private provider smoke is GitHub Actions, not a bare local credential check. Repository secrets are mapped by the workflow from `VERCEL_CONSUMER_*` and `DEVBOX_GITHUB_FIXTURE_*` into the smoke process's generic names.
- `vercel link` supplies only the team/project scope. The CLI reuses the Vercel SDK's valid local auth cache; device authorization is only expected when no explicit/OIDC credential or unexpired cache is available. This is independent of the requested branch.
- Pull requests never receive cloud credentials, and no label authorizes a run. To prove a branch against real infrastructure, dispatch the **Nightly** workflow against that ref:
  ```bash
  gh workflow run nightly.yml --ref <branch>          # build + smoke only
  gh workflow run nightly.yml --ref <branch> -f publish=true   # also publish @dev-<branch>
  gh run watch
  ```
- Coding-agent versions live in `images/vercel/agents.json` (the Dockerfile derives from it). The **Agent refresh** workflow checks daily and on manual dispatch for registry drift, validates an immutable candidate, and opens a reviewable promotion PR on `agent-update/agents`; merging the PR is the approval, and the scheduled Nightly then promotes the identical digest. It never retags a channel itself. Manual urgent refresh: `gh workflow run agent-refresh.yml -f agents=pi,claude`. See `docs/runbooks/agent-version-refresh.md`.
- Before calling UAT blocked, check `gh secret list` (names only) and the run's failure reason. A green CI run proves nothing about the cloud path — CI is credential-free by design. Only report missing credentials after a dispatched Nightly reaches its configuration gate and fails.
- The image pin is a build output, never source. Do not add a digest to `src/`; `scripts/vercel/emit-image-pin.mjs` writes it into `dist/` at publish time, and a checkout resolves the `nightly` channel. Set `DEVBOX_VERCEL_IMAGE` to a fully-qualified digest to run a locally built image. See [ADR 0004](docs/adrs/0004-image-pin-as-build-output.md).
- Never expose secret values from `.env`, `.env.local`, GitHub Actions, command output, logs, evidence, or metadata.
- For local linked-project Sandbox UAT, reuse the disposable linked fixture when present at `/Volumes/EVO/dev/uat-runs/devbox/5-core-vercel`: source its `.env.local` in the same child shell before invoking the CLI/SDK, keep `.vercel/project.json` local, and clean up the Sandbox/snapshots after the run. Do not pass `--token` in argv.
- Name new disposable Vercel test projects with the `uat_` prefix (for example, `uat_devbox`) so cleanup can find them as a group. Keep the verified legacy consumer project name unchanged until its replacement is fully re-verified; do not rename it speculatively.

## UAT Repo

A simple vite app exists as a private repo for testing: `gannonh/uat-devbox`.

Available locally and linked to a vercel project at `../uat-runs/devbox/uat-devbox/`

Clean-up by deleting remnant sandboxes when finished.