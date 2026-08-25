---
name: plan-build-verify
description: Use this skill for multi-step, spec-driven, or acceptance-gated implementation work in a GitHub repository where specs live as GitHub Issues. Routes work through Plan, Build, and Verify phases, favors demonstrable user-facing vertical slices over waterfall epics, manages the roadmap through issue labels and sub-issues, and triages and grooms the backlog. Also handles migration from file-based specs to GitHub Issues.
---

# Plan Build Verify

Route implementation work through a sequential path where **GitHub Issues are the source of truth for specs**. Two supporting modes, Triage and Migrate, manage the roadmap.

## Read the conventions first

Before any mode, read `references/conventions.md` completely. It defines the repo preflight, label taxonomy, issue body template, status transitions, sub-issue mechanics, issue dependencies, temporary body files, and coexistence with pstack and other skills in this pack. Every other reference file depends on it.

## Coexistence with pstack and other skills in this pack

GitHub Issues remain the source of truth for specs, priority, and the Plan / Build / Verify lifecycle. For GitHub-issue product repos (`devbox`, `kata-code`, `kata-agents`, `kata-symphony`), plan-build-verify is the only product OS.

| Skill / layer | Role | Not its job |
| ------------- | ---- | ----------- |
| **plan-build-verify** | Only product OS: specs, priority, Plan / Build / Verify, labels | Implementation tactics inside a Build or Verify run |
| **pstack** (Cursor plugin) | Engineering execution and proof inside Build and Verify; investigation during Plan (`architect` / `how` / `why`) | Planning, labels, approval, or a second issue lifecycle |
| **ps** (`/ps` in this pack) | Historical port of pstack; unwieldy; do not install for product delivery | Substitute for the pstack plugin or a second product OS |
| **okf** / finalize's OKF step | **Retired.** Remains in the library for history only | Any live roadmap or docs-as-spec workflow |
| **kata-linear** | Linear-first repos only | These four GitHub-issue product repos |

Rules:

- Do not skip an unapproved issue because "the best spec is code."
- For product-shaped work, an architect checkpoint during Plan is investigation only. Do not treat pstack's never-block-on-the-human stance as permission to build past an unapproved spec.
- A per-repo verification skill and feature map complement `## Demonstration` / `## Verification` on the issue. They do not replace acceptance criteria.
- Do not invent a second issue tracker or file-based specs. Do not create or maintain product specs under `docs/specs/` except the PBV migration index/archive described in `references/conventions.md`.
- Do not run `okf init`, `okf update`, or finalize's OKF step. OKF is retired; it is not an alternative roadmap.
- Do not install `ps`, `okf`, or `kata-linear` for these product repos. Install project-local skills with `scripts/install-skills.sh` (or the npx command in `references/conventions.md`). Never `npx skills add -g`, and never install the whole `gannonh/skills` pack.

## Phase contracts

| Phase   | Input                                                     | Output                                                                                                              | Status label transition                   |
| ------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Plan    | Idea, vague request, or new build request                  | Context exploration → alignment dialogue → approach approval → vertically sliced spec issue with mandatory `## Acceptance criteria` | none → `status:draft` → `status:approved` |
| Build   | Approved spec issue number, or explicit user override      | Implemented tasks, commits, review results, pushed branch, Build completion report comment                           | `status:approved` → `status:implemented`  |
| Verify  | Implemented spec issue plus completed work or Build report | Acceptance evidence, durable acceptance tests, pull request, green CI, resolved review threads, signoff recommendation | `status:implemented` → `status:verified`  |
| Triage  | Repo issue backlog                                         | Grooming report and applied label, decomposition, and closure actions                                               | corrective, per issue                     |
| Migrate | Existing `docs/specs/*.md` bundle                          | Assessment report, spec issues, archived local files, rewritten cross-links, updated specs index                    | derived from each file's declared status  |

## Select the workflow

Default to **Plan** unless the user explicitly directs you to execute an existing issue, verify completed work, groom the backlog, or migrate specs. A new build request starts at Plan even when the user says "build".

| Mode        | Reference               | Enter when                                                                                     |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| **Plan**    | `references/plan.md`      | Scoping, designing, or specifying work, or no `status:approved` issue exists for the request. |
| **Build**   | `references/build.md`     | Executing a named, approved spec issue.                                                       |
| **Verify**  | `references/verify.md`    | Proving completed work meets the issue's acceptance criteria.                                  |
| **Triage**  | `references/triage.md`    | Grooming the backlog, or answering "what should we work on next?".                            |
| **Migrate** | `references/migration.md` | Converting `docs/specs/*.md` into issues. Assess-first, one-way.                              |

Read `references/conventions.md` and then the selected reference file completely, and follow both. Only load the workflow you need.

**Build and Verify are one continuous run.** Build does not stop to ask whether to verify; it enters Verify directly. Verify then runs unattended through evidence, acceptance tests, PR creation, and CI convergence, stopping only at signoff. See the autonomy contract in `references/verify.md`.

Hard gates:

- Build must not start from a `status:draft` issue unless the user explicitly overrides the approval gate.
- Verify must not claim signoff without evidence.
- Verify must never merge the PR. Signoff and merge are the user's decision.
- Verify opens the PR, not Build. The PR body carries the acceptance-criteria matrix.
- In Plan, do not draft a spec issue before the user has answered an alignment question or approved a recommended direction. If you are about to, stop and ask instead.
- Migration is assess-first. Run `scripts/migrate_specs.sh --assess` and settle every unclassified or conflicting file with the user before any write.

For tiny, clearly bounded edits such as a copy change or single config tweak, do not force the full Plan workflow and do not open an issue. State the assumption and ask whether the user wants the full process. If the mode remains ambiguous, ask one focused question that resolves it.

## Bundled phase references

Build and Verify load bundled workflows from this skill directory. Read the entry point completely; follow linked files and scripts under the same subtree.

| Phase  | Workflow        | Entry point                              |
| ------ | --------------- | ---------------------------------------- |
| Build  | TDD             | `references/tdd/workflow.md`             |
| Verify | User acceptance | `references/user-acceptance/workflow.md` |

Verify's convergence loop (Step 7) drives CI with `gh pr checks --watch` and `gh run` directly. For review threads it uses one sibling skill, resolved against the installed skills directory:

| Purpose                           | Skill                 | Entry point                                               |
| --------------------------------- | --------------------- | --------------------------------------------------------- |
| Review-thread inventory and fixes | `address-pr-comments` | `<path-to-skills-directory>/address-pr-comments/SKILL.md`   |

If it is not installed, Verify reads threads with `gh api graphql` instead; the loop does not depend on it.

## Helper scripts

- `scripts/ensure_labels.sh`: idempotently creates this skill's label taxonomy. `--dry-run` reports what would change.
- `scripts/install-skills.sh`: project-local, non-interactive install of `plan-build-verify` and `address-pr-comments` only. Product repos can copy it. Never `-g`; never installs `ps`, `okf`, or `kata-linear`.
- `scripts/migrate_specs.sh`: bulk-converts `docs/specs/*.md` into spec issues, archives the sources, rewrites cross-links, and updates the specs index. Run `--assess`, then `--dry-run`, then apply.
- `scripts/rewrite_spec_links.py`: repoints Markdown links after files move into the archive. Called by the migration script; requires `python3`.

Resolve script paths against the skill directory the runtime actually loaded. If a configured skill path does not exist, stop and ask which installation to use. Never copy skill files into the project working tree to make a path resolve.

## Requirements

- `gh` CLI, authenticated with issue write access for the target repo.
- `gh sub-issue` extension (`yahsan2/gh-sub-issue`) for decomposed specs. If absent, install with `gh extension install yahsan2/gh-sub-issue` or use the task-list fallback in `references/conventions.md`. Its `create` subcommand has no `--body-file`, so children are created with `gh issue create` and then attached with `gh sub-issue add`.
- A `gh` recent enough for issue dependencies (`gh issue edit --add-blocked-by`). Native; no extension required.
- A git remote pointing at the GitHub repository that owns the roadmap.
- `jq`, for reading `gh sub-issue list --json` output. The extension has no `-q` flag of its own.
- `python3`, for link rewriting during migration only.

Run the preflight in `references/conventions.md` before the first `gh` write of a session. If `gh` is unavailable or unauthenticated, stop and tell the user. Do not fall back to writing spec files locally.

## Shared principles

- Inspect the repo and the issue backlog before making claims about project structure, commands, or existing work.
- Use a todo list when the work has multiple steps.
- In Plan, ask focused alignment questions one at a time before drafting the issue. If no factual clarification is needed, ask the user to confirm your framing, assumptions, and acceptance criteria.
- In Plan, propose 2-3 approaches when more than one viable direction exists. If one is clearly best, state the recommendation and wait for approval or redirection.
- Prefer the smallest end-to-end slice a user can see, use, or evaluate over broad unverified changes. “User” includes a human, operator, or API/SDK consumer.
- Decompose epics by demonstrable behavior, not by architecture layer, component, or team. Do not make storage, backend, protocol, frontend, and testing separate roadmap phases when one thin vertical slice can cross them.
- Use a technical-enablement child only when no safe end-to-end slice is feasible without it. Keep it minimal, explain why it cannot be folded into the first slice, and name the user-facing slice it immediately unlocks.
- Require a passing public-boundary E2E test for every user-facing slice and required starting/final screenshots for visual targets.
- Treat video as ideal temporal evidence, not an unbounded gate: make one bounded attempt, then skip and flag the environment/tooling gap when recording remains unavailable.
- Keep scope tied to the selected issue and its acceptance criteria.
- A spec issue is incomplete unless it has an exact `## Acceptance criteria` section with observable pass/fail criteria that Build can implement and Verify can test.
- The issue is the spec. Local Markdown exists only as a temporary body file and is removed after the `gh` write succeeds.
- Every phase transition updates the issue's `status:*` label. An issue whose label does not match its real state is a triage defect.
- Surface uncertainty instead of filling gaps with guesses.
