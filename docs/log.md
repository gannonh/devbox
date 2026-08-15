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
* **Vercel image supply chain build**: Added the digest-pinned Universal-derived image, explicit display/auth-proxy runtime, local contract check, bounded readiness gate, publisher and independent consumer Sandbox smoke workflow, redacted evidence artifacts, reviewed promotion PR generation, release pin validation, and operator runbook for issue [#4](https://github.com/gannonh/devbox/issues/4).

## 2026-08-14 (4)
* **Vercel image supply-chain compliance hardening**: Enforced all display/proxy process health, cancellable readiness deadlines, token-distinct consumer scopes and identity checks, strict smoke-reference and pin-scope parsing, terminal session/deletion/snapshot cleanup, evidence-gated promotion, structured stage timings, normalized visibility parsing, and consumer credential rotation guidance; credentialed live verification remains outside the local boundary.

## 2026-08-14 (5)
* **Vercel image supply-chain second review fixes**: Correlated the documented flat VCR repository response with explicitly scoped project/team responses, pinned the audited Vercel CLI, made deletion lookup non-resuming, strengthened named-check/timing/URL evidence validation, and made artifact publication fail closed on redaction errors.

## 2026-08-14 (6)
* **Vercel image supply-chain smoke liveness hardening**: Added abortable HTTP and bounded SDK/smoke/cleanup deadlines, eventual-consistency deletion recovery with final stop/delete attempts, executable version probes for required tools, and strict evidence primitive validation with malformed fixtures; credentialed live verification remains outside the local boundary.

## 2026-08-14 (7)
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
* **Credentialed VCR contract corrections**: Parsed VCR's flat tag response, verified publisher/consumer project ownership through scoped project API responses, and disabled BuildKit's optional attestation index so VCR readiness applies to the directly tagged `linux/amd64` manifest. Checked-in, embedded, upstream-verified provenance remains the promotion record.
