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
