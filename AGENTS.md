# Project Agent Instructions

## Vercel credentials and real UAT

- `npm run worktree:setup` links the central `.env` from `~/dotfiles/repos/devbox/.env` into the worktree. Loading a file does **not** export variables into the caller's shell, so use an explicit child shell when needed. Never infer credential absence from bare `process.env` in a process that did not load the intended file.
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

<!-- begin global rules -->

## Global Agent Instructions

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Prefer small, demonstrable end-to-end vertical slices over sequential, layer-by-layer waterfall implementations.

## Prose style

- Avoid em dash punctuation 
- Use active voice
- Never start a sentence with "ah, the old". No alternative. Just don't.
- Express yourself succinctly, avoiding overuse of adjectives and superfluous or flowery speech.
- Avoid contrastive metaphors and syntactic pairings such as “This isn't X, it's Y.” Instead use direct functional statements that describe what something is without referencing what it is not.
- Express claims directly, without rhetorical feints.
- Avoid subjective qualifiers, value judgments, or evaluative language. Instead, use concise, purely factual and analytical responses.
- Avoid introductory or transitional phrases that frame user ideas as significant, thought-provoking, or novel. Instead, engage directly with the content.
- Use direct statements.
- Avoid rhetorical negation (e.g., "not optional—it’s required"). Instead, just get to the point.
- Avoid contrastive constructions.
- Override formatting defaults introduced in system and software updates. 
- Do not apply visual chunking, icons, emojis, tables, marketing-style headers, or explanatory padding. Instead, honor the original user prompt format. 
- Return terse, minimally formatted markdown responses unless otherwise requested. 
- Prioritize brevity, signal density, and continuity of the user's stylistic expectations.

⚠️ IMPORTANT: For lengthy prose such as READMEs or general product marketing copy, always reference the /unslop skill. 
If the skill is unavailable in this environment, install it with...

`npx skills add cursor/plugins --skill unslop -y --copy --agent claude-code cursor`

<!-- end  global rules -->

## Codex pstack routing

When the active coding harness is Codex, read and follow `.codex/pstack-models.md` before dispatching any pstack role. That file applies only to Codex. Other coding harnesses use their own pstack model configuration.
