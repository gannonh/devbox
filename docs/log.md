# Bundle Update Log

## 2026-06-29
* **Initialization**: Created the OKF bundle root, specs roadmap, ADR scaffold, and AGENTS.md guidance.
* **Indexing**: Linked the implemented [@gannonh/devbox npm package](/specs/2026-06-28-devbox-npm-package-design.md) spec into the bundle map.

## 2026-06-30
* **Release access**: Marked the release workflow and package metadata public for npm publishing.

## 2026-06-30 (2)
* **Release workflow redesign**: Switched to publish-first single-trigger (manual dispatch only) so a failed `npm publish` leaves no tag or release page. Stage both `package.json` and `package-lock.json` in the version commit to avoid empty-commit failures on re-runs. Create a GitHub Release with `npx`/`npm install` instructions after publish succeeds. Reset repo version to `0.0.0` and deleted the dangling `v0.1.0` tag from the failed publish.
* **Branding scrub**: Removed `Kata Agents` from the shipped `templates/Dockerfile` header (now `devbox`) and neutralized `kata-agents` sample strings in test fixtures. Removed the now-resolved known-issue note from the spec. Spec historical provenance kept intact.
* **init guidance**: `init` now prints a post-create customization guide pointing at the repo-specific surfaces (`post-create.sh` hook, `devcontainer.json` ports/env, repo `.env` secrets, `provision.sh` agent switching, `Dockerfile` apt packages) before the boot prompt, rather than implying every generated file needs editing. Extended spec criterion 1 to cover the guide.
* **Agent skill**: Added `skills/devbox/SKILL.md` (a skill teaching coding agents how to use devbox), bundled it in the npm package (`files` now includes `skills`), and wired `init` to offer installing it to `.agents/skills/devbox/SKILL.md` (copies locally on `y`, skips in CI, always shows `npx skills add gannonh/devbox --skill devbox -y` for later install). Added spec criterion 15.

## 2026-08-14
* **First-boot worktree config**: `up` copies uncommitted `.devbox/` and `.devcontainer/` from the source checkout into a new worktree when `devcontainer.json` is missing, so `init` then `<branch>` works before those files are committed. `defaultBranch` now strips `refs/remotes/origin/` from origin HEAD (git prints `refs/remotes/origin/main`, not `refs/heads/main`), which was causing `git fetch origin refs/remotes/origin/main` to fail.
* **Worktree start point**: new branches start from `origin/<default>` after fetch, not local `main`. Fetch failure / missing origin ref falls back to local with a warning. Local-ahead commits warn but still start from origin. `DEVBOX_START_POINT=local` restores the previous behavior.
* **init skill prompt**: the Agent skill `y/N` prompt is a complete line through readline so it is visible on line-buffered stderr; skip message now says `Agent skill install skipped`.

## 2026-08-14 (2)
* **Vercel provider roadmap**: Planned and approved GitHub epic [#2](https://github.com/gannonh/devbox/issues/2) with five dependency-linked phases for provider foundations, a public digest-pinned VCR image, persistent remote workspaces, full noVNC/Chromium security parity, and acceptance convergence. Three adversarial review passes tightened cross-project image proof, scope/auth persistence, terminal signals, cleanup semantics, secret bounds, public-port behavior, and the Node.js runtime floor.
* **OKF navigation**: Linked the approved epic from the bundle and specs indexes; the GitHub issues remain the source of truth for the new specification.

## 2026-08-14 (3)

* **Provider foundation**: Added the typed lifecycle boundary and registry for Issue [#3](https://github.com/gannonh/devbox/issues/3), moved Docker/devcontainer lifecycle code under `src/providers/local/`, and preserved local as the default provider.
* **CLI grammar**: Added `--provider local|vercel`, provider-filtered `--list`, `--password`, stable argument errors, and explicit unsupported results for local display credentials without adding Vercel SDK behavior.
* **Architecture record**: Accepted [ADR 0001](./adrs/0001-provider-boundary.md) for the provider registry and local-provider isolation.

## 2026-08-14 (4)

* **Quality hardening**: Cleaned `dist` before builds and packs, handled missing child executables through the runner error boundary, and routed devcontainer stderr to caller-owned streams with regression coverage.
* **Spec navigation**: Updated the implemented package design's source paths to the local provider layout and cross-linked ADR 0001.
* **Residual risk**: The one-shot CLI still uses a module-global logger stream; converting it to a request-bound logger remains deferred to avoid widening the parity refactor.

## 2026-08-14 (5)

* **Roadmap correction**: Updated the specs roadmap to show #3 implemented with complete acceptance evidence in open PR #8 (awaiting sign-off/merge), #4 as the remaining active Build phase, and #5 → #6 → #7 dependency order unchanged.

## 2026-08-14 (6)
* **Vercel image supply chain build**: Added the digest-pinned Universal-derived image, explicit display/auth-proxy runtime, local contract check, bounded readiness gate, publisher and independent consumer Sandbox smoke workflow, redacted evidence artifacts, reviewed promotion PR generation, release pin validation, and operator runbook for issue [#4](https://github.com/gannonh/devbox/issues/4).

## 2026-08-14 (7)
* **Vercel image supply-chain compliance hardening**: Enforced all display/proxy process health, cancellable readiness deadlines, token-distinct consumer scopes and identity checks, strict smoke-reference and pin-scope parsing, terminal session/deletion/snapshot cleanup, evidence-gated promotion, structured stage timings, normalized visibility parsing, and consumer credential rotation guidance; credentialed live verification remains outside the local boundary.

## 2026-08-14 (8)
* **Vercel image supply-chain second review fixes**: Correlated the documented flat VCR repository response with explicitly scoped project/team responses, pinned the audited Vercel CLI, made deletion lookup non-resuming, strengthened named-check/timing/URL evidence validation, and made artifact publication fail closed on redaction errors.

## 2026-08-14 (9)
* **Vercel image supply-chain smoke liveness hardening**: Added abortable HTTP and bounded SDK/smoke/cleanup deadlines, eventual-consistency deletion recovery with final stop/delete attempts, executable version probes for required tools, and strict evidence primitive validation with malformed fixtures; credentialed live verification remains outside the local boundary.

## 2026-08-14 (10)
* **Vercel image supply-chain quality corrections**: Made promotion repeatable, passed both real tokens to all redaction paths, recovered owned resources after lost handles, bounded Universal digest probing, serialized and idempotent candidate publication, pinned apt metadata to a reviewed Ubuntu snapshot, shared strict evidence URL validation, and corrected scoped orphan/runtime runbook commands.

## 2026-08-15
* **Vercel image SDK-shaped cleanup correction**: Updated smoke, lost-handle recovery, and Universal digest cleanup for the pinned Sandbox 3.0.0 `Snapshot.list()` metadata shape by resolving IDs through `Snapshot.get`; added bounded delayed-discovery polling and residual snapshot convergence evidence. Credentialed live verification remains outside the local boundary.

## 2026-08-15 (2)
* **Vercel image final quality cleanup**: Made collection discovery and final Sandbox/snapshot listings authoritative and fail closed, normalized delayed snapshot evidence after convergence, added actual SDK list/get/delete behavior coverage, restricted promotion PR reuse to open PRs, pinned role-specific orphan commands, and made resolver evidence writes required.

## 2026-08-15 (3)
* **Vercel image live SDK API correction**: Added `sortBy: 'name'` to owned Sandbox discovery, bounded `Snapshot.list()` pages to 50 in resolver/smoke paths, aligned the runbook with `base-digest.json`, and documented manual digest-input runs without resolver evidence.

## 2026-08-15 (4)
* **Vercel Universal mirror correction**: Credentialed verification proved the managed Universal VMI is not OCI-pullable, so the user approved a deterministic mirror of its open-source recipe. Added checked-in provenance, digest/checksum/version pins, verified upstream Dockerfile hashes, an official pinned Chrome-for-Testing archive, empty inherited `CMD`, loopback-only internal noVNC, exact provenance-bound release validation, corrected live probes, and a successful local image/runtime/auth check.

## 2026-08-15 (5)
* **Credentialed VCR/Sandbox contract corrections**: Parsed VCR's flat tag response, verified publisher/consumer project ownership through scoped project API responses, disabled BuildKit's optional attestation index so VCR readiness applies to the directly tagged `linux/amd64` manifest, bounded SDK session-list pages to the live API maximum of 50, and prevented PR-triggered verification from proposing promotion. Checked-in, embedded, upstream-verified provenance remains the promotion record.

## 2026-08-15 (6)
* **Final credential and evidence hardening**: Bound same-repository credentialed verification to a repository-owner-applied full-head-SHA label, restricted manual dispatch to the owner and default branch, isolated write-capable promotion from the read-only candidate job, commit-pinned third-party actions, passed only ten required Vercel secrets, rebuilt every run under a never-reused candidate tag, preserved byte-hashed exact-digest raw OCI/zstd proof, required complete correlated runtime inventories, reconciled transient deletion errors, and verified remote promotion branch ancestry/content before reuse.

## 2026-08-15 (7)

* **Verified phase integration**: Merged the verified provider foundation and Vercel image supply chain, preserved both ADRs and their history during branch convergence, and unblocked the core Vercel workspace lifecycle phase.

## 2026-08-18
* **Vercel convergence**: Added the provider architecture/reference/runbook bundle and recorded the benchmark, UAT, release, cleanup, and public-port evidence contract for issue [#7](https://github.com/gannonh/devbox/issues/7).

## 2026-08-19
* **noVNC access-code pairing restored**: The printed `6080` display link carries a one-use access code again, so it opens the display on click. The proxy exchanges the code for an `HttpOnly; Secure; SameSite=Lax` cookie and redirects it out of the address bar, and both `token=` and `devbox_novnc=` are covered by the artifact redactors. Recorded as [ADR 0003](/adrs/0003-novnc-access-code-pairing.md), superseding the Basic Auth display clause of ADR 0002 — that clause had reverted a PR #11 review change that was never written down as a decision.
* **Vercel image lifecycle simplified**: The image digest is no longer a constant in `src/providers/vercel/image.ts`; it is emitted into the package at publish time, and a checkout resolves the `nightly` channel instead. This removed the second "promotion" pull request and the window where main disagreed with its own image, along with the `vcr:`/`psmoke:` exact-SHA label rituals, the write-capable promotion job, and `scripts/vercel/promote-image.mjs`. Recorded as [ADR 0004](/adrs/0004-image-pin-as-build-output.md).

## 2026-08-19 (2)
* **Zero-config public app ports on Vercel**: A normal Vite or Next repository no longer needs devbox-specific port configuration for issue [#13](https://github.com/gannonh/devbox/issues/13). After the remote checkout is ready, devbox reads that checkout's root `package.json` — `dependencies`, `devDependencies`, and the root `scripts.dev` string, as data only — offers the conventional or dev-script-declared port as a labeled **public** candidate, and applies the accepted set to the running Sandbox through `Sandbox.update({ ports })` without recreating it. Nothing is executed, workspaces are not traversed, and no script, source, or `.env` text reaches the terminal or the metadata.
* **Explicit and non-interactive behavior**: Configured `forwardPorts` remain the trusted host-configuration path and are always retained; inferred candidates are additive. Outside a TTY nothing new is exposed without `--expose-ports <comma-separated-list>`, which is valid only with a boot or `--attach` and validated for decimal form, duplicates, private ports, and the 15-port service maximum before any update.
* **Durable selection**: The confirmed selection is stored without secrets alongside the candidate fingerprint, detector version, and remote `git rev-parse HEAD`, so a resume re-applies the same routes without prompting. Route updates are written pending-then-commit, and an interrupted update is reconciled against the Sandbox's actual routes — committed, cleared, or restored — never assumed.
* **Pinned SDK contract**: `@vercel/sandbox` is pinned to exactly `3.0.0` in both `package.json` and the lockfile, and the client boundary asserts the exact `update({ ports })` request and full-list replacement semantics.
* **The port maximum is 14, measured**: The live check the ticket required found three disagreeing sources. The installed 3.0.0 declaration comments "up to 4 ports"; the request schema refuses a 16th with `` `ports` should NOT have more than 15 items ``; and an update carrying exactly 15 fails with an opaque 500 every time, with any port values. Devbox caps the full set at 14 (13 app ports plus `6080`) so an over-large set fails with an actionable message instead of a 500. Reproduce with `scripts/vercel/app-port-uat.mjs`.
* **Two behaviors the UAT surfaced**: a port update regenerates every route's `*.vercel.run` subdomain, so a URL copied before an update goes stale — devbox re-reads routes after updating and always prints current URLs. And Vite 5.4.12+ rejects the generated host unless the project sets `server.allowedHosts`; that is the app's own reverse-proxy setting, documented in the reference rather than worked around in devbox.
* **Monorepos, after the fixture flattered the first cut**: the original detector read only the repository root `package.json`, which passed a fixture whose root *was* the Vite app and returned nothing for a real Turborepo, where the root is a task-runner shell and the app is in `apps/web`. It now also reads the manifests of declared workspace members, discovered from the `workspaces` field and/or `pnpm-workspace.yaml` — the latter being the only declaration in many pnpm repos. Candidates carry their workspace path (`5173 (vite default — apps/web)`), patterns admit only literal paths and one-level wildcards, and `.`/`..` segments are refused so nothing can read outside the checkout.
* **A no-candidate prompt**: inferring nothing no longer dead-ends. A TTY is asked anyway so a port can be named by hand, with the default inverted — Enter exposes nothing — so a repository with no web app stays one keystroke from booting. Non-interactive behavior is unchanged.
* **Provider notice**: the remembered-provider line is now `[devbox/vercel] (change with --provider [local|vercel])`, tagging the provider rather than describing it in prose, and listing the registry's names so it stays correct as providers are added.
* **`--rm` stopped claiming nothing exists while `--list` showed a box**: a same-branch sandbox in another Vercel team/project is deliberately never touched — the identity hash folds in team and project, and that guard is correct — but removal reported "No Vercel sandbox exists for `<branch>`; nothing to remove", which reads as broken when a listing is showing one. It now names the sandboxes it declined and the scope switch that would reach them. Found by exploratory testing, not by a test.

## 2026-08-20
* **Agent version refresh**: Issue [#12](https://github.com/gannonh/devbox/issues/12) — declared the four supported coding agents in `images/vercel/agents.json` with an exact-pin policy, made the Dockerfile derive its install pins from the manifest, and added the daily/manual **Agent refresh** workflow that detects registry drift, applies manifest + provenance updates, builds an immutable candidate, runs the exact-digest publisher/consumer smokes, and opens one reviewable promotion PR. Accepted [ADR 0006](./adrs/0006-agent-version-manifest.md).
