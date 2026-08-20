# GitHub Conventions

Shared contract for every mode of this skill. Read this file completely before Plan, Build, Verify, Triage, or Migrate.

## Core rule

**The GitHub Issue is the spec.** Local Markdown is a temporary body file used to compose or edit an issue body, and it is deleted once the `gh` write succeeds. Nothing spec-shaped stays in the repo working tree.

If `gh` fails, stop and report the failure. Do not save the spec as a repo file as a fallback; that recreates the two-sources-of-truth problem this skill exists to remove.

## Preflight

Run once per session, before the first `gh` write.

```bash
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef -q '.nameWithOwner + " (default: " + .defaultBranchRef.name + ")"'
gh extension list | grep -q 'gh sub-issue' && echo "sub-issue: present" || echo "sub-issue: missing"
```

Checks:

1. **Authentication.** If `gh auth status` fails, stop and ask the user to run `gh auth login`.
2. **Target repo.** `gh repo view` resolves from the current git remote. If the repo is a fork or the roadmap lives elsewhere, ask the user which repo owns the roadmap and pass `--repo <owner>/<name>` on every subsequent command.
3. **Issues enabled.** If `gh issue list` errors with issues disabled, stop and tell the user.
4. **Labels.** Run `scripts/ensure_labels.sh` (see below). It is idempotent and safe to re-run.
5. **Sub-issue extension.** Required only when decomposing a spec. If missing, offer `gh extension install yahsan2/gh-sub-issue` or use the fallback in "Sub-issues" below. Note its `create` subcommand has no `--body-file`; always use the two-step form in "Sub-issues".
6. **Dependency support.** Native, no extension needed, but it requires a recent `gh`. If `gh issue edit --help` does not list `--add-blocked-by`, tell the user to upgrade `gh` and record dependencies in the issue body prose until they do.

Record the resolved `<owner>/<repo>` for the session and reuse it.

## Label taxonomy

This skill owns three namespaces and creates them automatically:

| Label                       | Color    | Meaning                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------ |
| `kind:spec`                 | `0E8A16` | A standalone spec issue. Every spec issue carries this.            |
| `kind:epic`                 | `5319E7` | A spec decomposed into sub-issues. Carries `kind:spec` as well.    |
| `kind:sub-spec`             | `C2E0C6` | A child issue produced by decomposing an epic.                     |
| `status:draft`              | `FBCA04` | Spec is being written or revised. Build is blocked.                |
| `status:approved`           | `0E8A16` | User approved the spec. Build may start.                           |
| `status:implemented`        | `1D76DB` | Build completed and reported. Verify may start.                    |
| `status:verified`           | `0052CC` | Acceptance evidence accepted by the user.                          |
| `status:blocked`            | `B60205` | Work cannot proceed. The issue body states why.                    |
| `phase:plan`                | `D4C5F9` | Currently in Plan.                                                 |
| `phase:build`               | `BFD4F2` | Currently in Build.                                                |
| `phase:verify`              | `C5DEF5` | Currently in Verify.                                               |
| `needs:acceptance-criteria` | `E99695` | Issue has no usable `## Acceptance criteria` section.              |
| `needs:decomposition`       | `E99695` | Scope is too large for one spec.                                   |
| `needs:triage`              | `E99695` | Issue has not been groomed into this skill's model.                |

Rules:

- `status:*` labels are **mutually exclusive**. Every transition removes the old one and adds the new one in a single `gh issue edit` call.
- `phase:*` labels are also mutually exclusive and reflect what is happening right now. Remove the `phase:*` label when a phase ends without immediately starting the next one.
- `needs:*` labels are triage flags. Clear them when the underlying gap is fixed.
- **Adopt existing repo labels** for area, component, priority, and type. Run `gh label list --limit 200` during preflight and reuse what already exists rather than creating parallel labels. Only the three namespaces above belong to this skill.

Create or repair the taxonomy:

```bash
bash <skill-dir>/scripts/ensure_labels.sh                 # current repo
bash <skill-dir>/scripts/ensure_labels.sh --repo owner/name
bash <skill-dir>/scripts/ensure_labels.sh --dry-run
```

The script uses `gh label create --force`, which creates missing labels and updates color and description on existing ones. It never deletes labels.

## Temporary body files

Compose issue bodies in a scratch file, then write through `gh`:

```bash
BODY="$(mktemp -t pbv-spec).md"
# write the spec body to "$BODY"
gh issue create --title "<title>" --body-file "$BODY" --label "kind:spec,status:draft,phase:plan"
rm -f "$BODY"
```

Rules:

- Use the session scratchpad directory or `mktemp`. Never write drafts into the repo working tree, not even temporarily, and never into `docs/`.
- Delete the file after the `gh` command exits successfully.
- To revise an issue body, pull the current body down, edit it, push it back, then delete the file:

```bash
gh issue view <N> --json body -q .body > "$BODY"
# edit "$BODY"
gh issue edit <N> --body-file "$BODY"
rm -f "$BODY"
```

- Always round-trip through `--body-file`. Passing multi-line spec bodies through `--body` on the command line mangles backticks, quotes, and newlines.

## Spec issue body template

Use this shape for `kind:spec` and `kind:sub-spec` issues. Scale each section to the work; omit sections that do not apply. `## Status`, `## Acceptance criteria`, and `## Delivery slices` are mandatory and must use these exact headings. `## Demonstration` is also mandatory for every standalone spec or sub-spec that Build can execute; an epic parent delegates demonstrations to its children.

```markdown
## Status

Draft

## Goal

<the outcome, in one or two sentences>

## Context

<current state, verified facts about the repo, links to related issues, PRs, ADRs, or designs>

## Constraints and non-goals

<explicit boundaries, governing rules, and what this spec will not do>

## Acceptance criteria

- [ ] <observable pass/fail outcome>
- [ ] <observable pass/fail outcome>

## Architecture

<component relationships, boundaries, data flow, Mermaid diagram when relationships matter>

## Delivery slices

1. <user-observable outcome>: end-to-end behavior, likely layers/files, acceptance tie-in, and demo
2. <next user-observable outcome>: end-to-end behavior, likely layers/files, acceptance tie-in, and demo

## Demonstration

- Consumer: <human, operator, or API/SDK client>
- Action or input: <what they do>
- Observable result: <what becomes visible or usable>
- Evidence: <how to exercise, inspect, or capture it>

<For an unavoidable technical-enablement exception, instead record the blocker, minimum scope, contract/integration evidence, and immediate user-facing slice unlocked.>

## Verification

<required public-boundary E2E command; additional unit/integration checks; required screenshot checkpoints for visual targets; preferred video recorder or expected environment limitation; manual UAT steps>

## Risks and mitigations

<specific risks with practical mitigations>

## Build handoff

- Approved scope: <...>
- Non-goals: <...>
- Ordered slices: <...>
- Required verification commands: <...>
- Fixtures or credentials needed: <...>
- Blocking open questions: None
```

Notes:

- Write acceptance criteria as GitHub task-list checkboxes (`- [ ]`). Verify checks them off as each one passes, which makes the issue show live acceptance progress in the list view.
- `## Delivery slices` is mandatory for all specs; an epic parent lists its children, while a sub-spec usually contains one slice. It describes increments of demonstrable behavior, not storage/backend/frontend/testing work packages. A slice crosses whichever technical layers it needs to produce an observable outcome.
- `## Demonstration` is mandatory for standalone specs and sub-specs. It must name the consumer, action/input, observable result, and evidence that works without waiting for later siblings. A technical-enablement exception records its blocker, minimum scope, contract/integration evidence, and immediate user-facing slice unlocked instead.
- Every user-facing slice plans a passing public-boundary E2E test. Visual slices also plan required starting/final screenshots. Video is ideal when temporal behavior matters, but its tooling is best-effort: use the documented bounded attempt and skip-and-flag contract instead of making Verify spin.
- The `## Status` section mirrors the `status:*` label. Both must agree. Update them in the same turn.
- Do not use YAML frontmatter in issue bodies. GitHub renders it as a table or as literal text. Status lives in the `## Status` section and the label.

## Status transitions

| Transition                             | When                                                   | Command                                                                                             |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| create → `status:draft`                | Plan publishes the spec issue                          | `gh issue create --label "kind:spec,status:draft,phase:plan"`                                        |
| `status:draft` → `status:approved`     | User explicitly approves the written spec              | `gh issue edit N --remove-label status:draft --add-label status:approved --remove-label phase:plan`  |
| `status:approved` → `status:implemented` | Build completes all gates and posts its report       | `gh issue edit N --remove-label status:approved,phase:build --add-label status:implemented`          |
| `status:implemented` → `status:verified` | User accepts the acceptance evidence                 | `gh issue edit N --remove-label status:implemented,phase:verify --add-label status:verified`         |
| any → `status:blocked`                 | Work cannot proceed; reason recorded in a comment      | `gh issue edit N --remove-label <current> --add-label status:blocked`                                |
| `status:approved` → `status:draft`     | User requests changes after approval                   | `gh issue edit N --remove-label status:approved --add-label status:draft,phase:plan`                 |

Update the `## Status` section in the body to match, in the same turn as the label change.

Close the issue only when it reaches `status:verified`, or when the user decides the work will not be done. A merged PR containing `Closes #N` closes the issue automatically; if Verify has not run, reopen it or record why verification was skipped.

## Sub-issues

Decompose when a spec contains more than one independently deliverable and verifiable user outcome, or when the user asks.

**Structure: parent holds the outcome; children each deliver a vertical slice.**

A vertical slice is the thinnest end-to-end behavior that a human, operator, or API/SDK consumer can see, use, or evaluate. It may cross storage, domain logic, backend, protocol, UI, documentation, and tests. Those layers are implementation tasks inside the slice, not sibling roadmap issues.

- The parent issue keeps goal, context, constraints, architecture, risks, and top-level acceptance criteria. Label it `kind:spec,kind:epic`.
- Derive children from user journeys and acceptance outcomes. Each child gets its own scoped `## Acceptance criteria`, mandatory `## Demonstration`, and `## Build handoff`. Label each `kind:sub-spec` plus its own `status:*`.
- Make the first child a walking skeleton when feasible: a narrow real path through the system that users can exercise and that later slices deepen.
- Do not create separate schema/storage, backend, protocol, frontend, test, or polish children when a useful end-to-end slice can include the minimum needed from each.
- A technical-enablement child is an exception. Use one only when safety or feasibility prevents a thin end-to-end slice; keep it minimal, document why, and identify the immediate user-facing child it unlocks. That child must directly depend on the enabler and come next in delivery order. Do not chain technical-enablement children.
- Children link back to the parent in their `## Context` section.
- Build and Verify run per sub-issue, so each completed child must leave the product in a coherent, demonstrable state. The parent reaches `status:verified` only when every child is `status:verified` and the parent's own top-level acceptance criteria pass.

**Create children in two steps: `gh issue create`, then `gh sub-issue add`.**

`gh sub-issue create` accepts only `--body string`. It has no `--body-file`, and passing one fails with `unknown flag: --body-file` without creating the issue. Spec bodies are multi-line Markdown, so they must go through `--body-file`. Create the issue normally, then attach it to the parent:

```bash
CHILD_URL=$(gh issue create \
  --title "<user-observable outcome>" \
  --body-file "$BODY" \
  --label "kind:sub-spec,status:approved")
CHILD="${CHILD_URL##*/}"          # gh issue create prints the URL, not JSON
rm -f "$BODY"

gh sub-issue add <N> "$CHILD"    # attach to the parent
gh sub-issue list <N>            # inspect the hierarchy
```

This produces the same native parent/child link as `gh sub-issue create` while preserving body fidelity. Never fall back to `--body` to make the one-step form work; it mangles backticks, quotes, and newlines.

If the `gh sub-issue` extension is unavailable and the user does not want to install it, fall back to a `## Sub-issues` task list in the parent body (`- [ ] #143`) and keep it current by hand. State clearly in the report that native sub-issue links were not used.

Do not nest more than one level. If a child needs decomposition, the parent scope was wrong; return to Plan.

## Dependencies

Sub-issue links express **composition** (this phase is part of that epic). They say nothing about **order**. When one issue cannot start until another is done, record it as a native GitHub dependency so the block is visible in the UI and queryable, rather than only as prose in `## Context`.

This is built into `gh`; no extension is needed.

```bash
gh issue create --title "..." --body-file "$BODY" --blocked-by 143,144
gh issue edit <N> --add-blocked-by 143      # N cannot start until 143 is done
gh issue edit <N> --add-blocking 145        # N must finish before 145 starts
gh issue edit <N> --remove-blocked-by 143   # dependency no longer holds
gh issue view <N> --json number,title,blockedBy,blocking
```

Flags take comma-separated issue numbers or URLs, and work across repos by URL.

Use a dependency when:

- A slice consumes a schema, interface, migration, or endpoint that an earlier slice creates.
- Two issues touch the same surface and would conflict if built in parallel.
- An issue is waiting on an external decision tracked in another issue.

Do not use one when:

- The relationship is merely thematic, or the order is only a preference. Over-linking turns the graph into noise and hides real blocks.
- The relationship is parent/child. That is `gh sub-issue add`, not a dependency. An epic is not "blocked by" its own slices.

Rules:

- A schema, interface, migration, endpoint, or component dependency does not by itself justify a standalone architecture child when the minimum work can live inside the first demonstrable slice. Record true blockers, but do not turn a preferred layer order into roadmap phases.
- An approved technical-enablement child must be the direct `blockedBy` dependency of the immediate user-facing slice named in its exception. A chain of technical-only children is a decomposition defect.
- Dependencies are advisory in GitHub; nothing prevents building a blocked issue. Treat an open blocker as a stop condition anyway, and say so rather than silently proceeding.
- Keep them current. A `blockedBy` pointing at a `status:verified` or closed issue is stale and is a triage defect.
- Prefer `--add-blocked-by` on the dependent issue over `--add-blocking` on the blocker. Both create the same edge, but consistently writing it from the dependent side keeps the intent readable.
- A dependency cycle is a decomposition error. Return to Plan and re-cut the slices.

## Branches and pull requests

- Branch name: `<issue-number>-<kebab-title>`, for example `142-export-workflow`. Derive it from the issue with `gh issue develop <N> --name <branch> --base <default>` when the user wants GitHub to link the branch to the issue.
- One branch per spec issue or per sub-issue. Never build two issues on one branch.
- **Verify opens the PR, not Build.** Build pushes the branch; Verify opens the PR once acceptance evidence exists, so the PR body carries the matrix and CI runs against verified work.
- The PR body must contain `Closes #<N>` for the issue it implements. For a sub-issue, close the sub-issue, not the parent.
- Link the PR back to the issue with a comment when the PR is opened from a branch GitHub did not auto-link.

## Comments

Post reports and evidence as issue comments, using a body file:

```bash
gh issue comment <N> --body-file "$REPORT"
rm -f "$REPORT"
```

Conventions:

- Build completion report: comment starting with `## Build completion report`.
- Verify evidence: comment starting with `## Verify: acceptance criteria matrix`.
- Deviation approvals: comment starting with `## Approved deviation`.
- Blocking reasons: comment starting with `## Blocked`.

The issue plus its comments is the complete record for the work. A reader should be able to reconstruct scope, decisions, implementation, and acceptance from the issue alone.

Image and video artifacts cannot be uploaded through `gh`. Reference their repo-relative or absolute paths in the comment, and tell the user which artifacts they may want to drag into the issue by hand.

## Querying the roadmap

```bash
gh issue list --label kind:spec --state open --json number,title,labels,updatedAt
gh issue list --label status:approved --state open          # ready to build
gh issue list --label status:implemented --state open       # ready to verify
gh issue list --label needs:acceptance-criteria --state open
gh issue view <N> --json number,title,body,labels,state,comments,url
gh search issues --repo <owner>/<repo> "<keywords>" --state open   # duplicate check
```

Before Plan creates a new spec issue, search for an existing issue covering the same work. Extend the existing issue instead of opening a duplicate.

## What migration leaves in the repo

After migration, `docs/specs/` holds no spec documents. It keeps only:

- `index.md`, a pointer stating the roadmap lives in GitHub Issues, with the queries needed to read it.
- `log.md`, holding the dated migration receipt. This is a record of what the migration did, not a document to maintain going forward.
- `archive/`, holding the original files with normalized frontmatter.

### Archived spec frontmatter

Every archived file carries the same normalized shape, so the frontmatter and the pointer line in the body always agree:

| Key             | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| `type`          | The original `type`, or `Spec` when the source file had none.             |
| `title`         | The original `title`, first `# ` heading, or a title derived from the name. |
| `status`        | `Migrated` when the spec became an issue. `Completed` when archived as finished work. |
| `source_status` | The status the file declared before the migration.                        |
| `github_issue`  | The issue number. Present only when `status: Migrated`.                    |
| `migrated`      | `true` for issue-backed specs, `false` for completed ones.                 |
| `archived_at`   | UTC timestamp of the archive operation.                                   |

The pre-migration status is preserved in `source_status` rather than left in `status`. Two keys with two different answers to "is this done" is worse than either answer alone.

Use this content for `docs/specs/index.md`:

````markdown
# Specs

Specs for this project are GitHub Issues. This directory holds no spec documents.

## Read the roadmap

```bash
gh issue list --label kind:spec --state open            # all active specs
gh issue list --label status:approved --state open      # approved, ready to build
gh issue list --label status:implemented --state open   # built, awaiting verification
gh issue view <N>                                       # read a spec
gh sub-issue list <N>                                   # read an epic's slices
```

## Status model

| Label                | Meaning                                     |
| -------------------- | ------------------------------------------- |
| `status:draft`       | Being written or revised. Do not build.     |
| `status:approved`    | Approved by the maintainer. Ready to build. |
| `status:implemented` | Built and reported. Ready to verify.        |
| `status:verified`    | Acceptance evidence accepted.               |
| `status:blocked`     | Cannot proceed. See the issue body.         |

## Writing and executing specs

Use the `plan-build-verify` skill. It publishes specs as issues, runs Build against approved issues, and posts acceptance evidence back to the issue.

## Archive

Pre-migration spec files are preserved under [`archive/`](./archive/) with links to their issues. They are historical and are not maintained.
````

The migration script appends the previous index content below this pointer under a "Roadmap context carried over from the previous index" heading rather than discarding it. Reconcile that section against the GitHub roadmap and delete it once the active and deferred items exist as issues. Pass `--replace-index` only when the previous index holds nothing worth keeping.

Add this to `AGENTS.md` during migration:

```markdown
## Specs live in GitHub Issues

Specs for this repository are GitHub Issues, not files. `docs/specs/` holds only an index pointer and an archive of pre-migration specs.

- Read the roadmap with `gh issue list --label kind:spec --state open`.
- Read a spec with `gh issue view <N>`; read an epic's slices with `gh sub-issue list <N>`.
- Do not create spec files under `docs/specs/`. Use the `plan-build-verify` skill, which publishes specs as issues.
- Never build an issue that is not labeled `status:approved` without explicit maintainer approval.
- Post build reports and acceptance evidence as comments on the spec issue.
- ADRs remain files under `docs/adrs/`. Cross-link them with the issues they constrain.
```

## Phase-entry hygiene check

At the start of Plan, Build, and Verify, run a lightweight check on the issues in scope and **report** problems without fixing them:

```bash
gh issue view <N> --json number,title,labels,body,state
```

Report when:

- The issue has no `status:*` label, or more than one.
- The `## Status` section disagrees with the `status:*` label.
- `## Acceptance criteria` is missing, empty, or contains vague language.
- A standalone spec or sub-spec has no independently exercisable `## Demonstration` through a human, operator, or API/SDK public interface, unless it documents a justified minimal technical-enablement exception and the immediate user-facing slice it unlocks.
- An epic has no sub-issues, a sub-issue has no parent, or the children are architecture-layer work packages rather than demonstrable vertical slices.
- A technical-enablement child does not directly block the immediate user-facing slice named in its exception, or another technical-only child intervenes.
- The issue is closed but not `status:verified`.
- The issue duplicates another open spec issue.

State the findings in one short block, then continue with the requested phase unless a finding blocks it (missing acceptance criteria blocks Build and Verify; an unapproved status blocks Build). To fix hygiene problems across the backlog, run Triage.

## Safety rules

- Never close, delete, or bulk-relabel issues you did not open without user approval.
- Never edit an issue body you have not read in full in this session.
- Never force-push or amend commits on a branch linked to an issue another agent or person is working on.
- When a `gh` write fails, report the exact command and error. Do not retry silently and do not fall back to local files.
