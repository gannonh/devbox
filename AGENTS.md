# Project Agent Instructions

## Vercel credentials and real UAT

- Devbox resolves `.env` to the repository-local file by default; `DEVBOX_ENV` is the explicit override. `npm run worktree:setup` never copies or links environment files. Loading a file does **not** export variables into the caller's shell, so use an explicit child shell when needed. Never infer credential absence from bare `process.env` in a process that did not load the intended file.
- For local commands that need `.env`, load it only in the child shell and never print values or pass secrets in argv:
  ```bash
  (set -a; . "$PWD/.env"; set +a; <command>)
  ```
- The canonical private provider smoke is GitHub Actions, not a bare local credential check. Repository secrets are mapped by the workflow from `VERCEL_CONSUMER_*` and `DEVBOX_GITHUB_FIXTURE_*` into the smoke process's generic names.
- `vercel link` supplies only the team/project scope. The CLI reuses the Vercel SDK's valid local auth cache; device authorization is only expected when no explicit/OIDC credential or unexpired cache is available. This is independent of the requested branch.
- A credentialed PR smoke is intentionally skipped until the repository owner applies the exact current-head label:
  ```bash
  head_sha="$(gh pr view <number> --json headRefOid -q .headRefOid)"
  gh label create "psmoke:${head_sha}" --color B60205 --description 'Authorize provider smoke for this exact SHA' --force
  gh pr edit <number> --add-label "psmoke:${head_sha}"
  gh pr checks <number> --watch
  ```
- Before calling UAT blocked, check `gh secret list` (names only) and the PR check reason. `skipping` means the authorization label is absent; it is not evidence that credentials are missing. Only report missing credentials after the authorized workflow reaches its configuration gate and fails.
- Never expose secret values from `.env`, `.env.local`, GitHub Actions, command output, logs, evidence, or metadata.
- For local linked-project Sandbox UAT, reuse the disposable linked fixture when present at `/Volumes/EVO/dev/uat-runs/devbox/5-core-vercel`: source its `.env.local` in the same child shell before invoking the CLI/SDK, keep `.vercel/project.json` local, and clean up the Sandbox/snapshots after the run. Do not pass `--token` in argv.
- Name new disposable Vercel test projects with the `uat_` prefix (for example, `uat_devbox`) so cleanup can find them as a group. Keep the verified legacy consumer project name unchanged until its replacement is fully re-verified; do not rename it speculatively.

