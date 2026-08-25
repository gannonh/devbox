# Triage Workflow

Use this workflow to groom the issue backlog so the roadmap stays readable and every spec issue is in a state Build or Verify can act on.

Triage is on-demand. It never runs automatically. Plan, Build, and Verify perform a lightweight read-only hygiene check at phase entry and report findings; fixing them is this workflow's job. Read `references/conventions.md` before starting.

## Scope

Ask which scope to groom if the user did not say:

- **Full backlog** — every open issue in the repo.
- **Spec backlog** — `kind:spec` issues only. Default when the user says "groom the roadmap".
- **One epic** — a parent and its sub-issues.
- **Untriaged** — issues labeled `needs:triage` or carrying no `kind:*` label.

## Step 1: Load the backlog

```bash
gh issue list --state open --limit 200 \
  --json number,title,labels,state,updatedAt,createdAt,assignees,milestone,url

gh issue list --label kind:spec --state open --limit 200 \
  --json number,title,labels,body,updatedAt,url

gh issue list --label kind:epic --state open \
  --json number,title,url            # then gh sub-issue list <N> for each

gh issue list --state closed --limit 50 \
  --json number,title,labels,closedAt,url
```

Read issue bodies for the specs in scope. Do not judge an issue from its title.

## Step 2: Detect defects

Check every issue in scope against these rules.

**Label integrity**

- No `status:*` label on a `kind:spec` issue.
- More than one `status:*` label.
- More than one `phase:*` label.
- A `phase:*` label on an issue nobody is working on. A stale `phase:build` label means an abandoned branch or a crashed session.
- Leftover `phase:plan` on a `status:approved`, `status:implemented`, or `status:verified` issue. Approval must remove `phase:plan` in the same turn; treat leftovers as hygiene to clear.
- No `kind:*` label on an issue that is clearly a spec.
- A `needs:*` flag whose underlying gap is already fixed.
- Do not treat adopted type labels (`enhancement`, `feature`, `bug`, and similar) as plan-build-verify defects. They are repo labels outside the `kind:` / `status:` / `phase:` / `needs:` namespaces; leave them alone unless the user asks to change them.

**Body integrity**

- Missing `## Status` section, or a `## Status` value that disagrees with the `status:*` label. A `Draft` body with `status:approved` is a defect to report, not proof the label is right.
- Missing `## Acceptance criteria` heading.
- Acceptance criteria present but not checkbox-formatted, empty, or written with vague language ("works", "fast", "robust", "easy") and no observable threshold.
- Missing `## Build handoff` on a `status:approved` issue.
- A standalone spec or sub-spec missing `## Demonstration`, or whose demonstration depends on unfinished sibling issues before any behavior is observable.
- A normal demonstration that shows only an internal artifact, migration, unit test, schema, or component. It must name a human, operator, or API/SDK consumer and exercise a public interface; otherwise require the technical-enablement exception.
- `Blocking open questions` that is not `None` on a `status:approved` issue.
- Placeholder text: `TBD`, `TODO`, `<...>`, unfilled template sections.

**State integrity**

- Closed but not `status:verified`, with no comment explaining why.
- `status:verified` but still open.
- `status:implemented` with no Build completion report comment.
- `status:verified` with no acceptance criteria matrix comment.
- `status:blocked` with no comment stating the blocker, or a blocker that has since been resolved.

**Hierarchy integrity**

- `kind:epic` with no sub-issues.
- `kind:sub-spec` with no parent.
- A sub-issue whose acceptance criteria do not roll up to any parent criterion.
- A parent whose acceptance criteria are not covered by any child.
- Children cut primarily by architecture layer or component—such as storage, backend, protocol, frontend, and tests—when none delivers a consumer/action → observable result through a public interface.
- A technical-enablement child with no documented necessity, minimum scope, contract evidence, or named immediate user-facing slice.
- Sub-issues nested more than one level deep.
- A parent at `status:verified` with unverified children.

**Dependency integrity**

Read the graph with `gh issue view <N> --json number,title,state,labels,blockedBy,blocking`.

- A `blockedBy` edge pointing at a closed or `status:verified` issue. Stale, and it will stop a Build that should proceed.
- An epic listed as blocked by its own children. That is composition, not a dependency; remove the edge.
- A dependency cycle. This is a decomposition error, not a label defect.
- A child whose `## Context` states "Depends on #N" with no matching `blockedBy` edge, so the block is invisible to the UI and to Build.
- An issue blocked by something in a repo the user cannot access.
- A technical-enablement child whose named user-facing slice does not directly depend on it, does not come next in delivery order, or is separated from it by another technical-only child.

**Scope integrity**

- A spec whose acceptance criteria span more than one independently deliverable user outcome. Flag `needs:decomposition`.
- A waterfall epic whose children expose only internal technical artifacts rather than public-interface behavior for a human, operator, or API/SDK consumer. Flag `needs:decomposition` and return it to Plan for re-slicing.
- Duplicate or overlapping specs. Check with `gh search issues --repo <owner>/<repo> "<keywords>"`.
- An issue that is a bug report or chore rather than a spec, carrying `kind:spec`.

**Staleness**

- `status:draft` untouched for more than 30 days.
- `status:approved` untouched for more than 60 days with no branch or PR.
- `status:implemented` untouched for more than 14 days. Verification is overdue.
- `status:blocked` untouched for more than 30 days.

Use `updatedAt` for these, and adjust the thresholds to the repo's actual cadence. State the thresholds you used.

## Step 3: Report before acting

Present findings grouped by severity. Do not mutate anything yet.

```text
Blocking (Build or Verify cannot run)
  #150  no acceptance criteria                        → add needs:acceptance-criteria
  #147  status:approved but Blocking open questions: 2 → return to Plan
  #142  label status:approved, body says Draft         → Build blocked; ask before reconciling

Integrity (state is misleading)
  #139  closed, never verified                         → reopen or record why
  #155  kind:epic with no sub-issues                   → decompose or drop kind:epic
  #140  status:approved with leftover phase:plan       → remove phase:plan

Hygiene (safe corrections)
  #161  no kind:* label                                → add kind:spec
  #158  phase:build, no branch since 2026-06-02        → remove phase:build
  #144  has enhancement + kind:spec                    → leave enhancement (adopted type label)

Stale (needs a decision)
  #133  status:draft, 74 days untouched                → close, or revive?
  #128  status:approved, 91 days, no branch            → still on the roadmap?

Scope
  #149 and #152 overlap on export handling             → merge, or split the boundary?
  #156 children are storage → API → UI layers           → re-slice by demonstrable user outcome
```

## Step 4: Apply corrections

Apply in tiers, and get approval before anything in tier 2 or 3.

**Tier 1: safe, apply directly.** Report what you did.

- Add a missing `kind:*` label that is unambiguous from the body.
- Add `needs:acceptance-criteria`, `needs:decomposition`, or `needs:triage` flags.
- Remove a `needs:*` flag whose gap is fixed.
- Remove a stale `phase:*` label when no branch or PR is active, including leftover `phase:plan` after a real approval.
- Reconcile a `## Status` section to match its `status:*` label only when independent evidence shows the label is right: a Build report comment, a merged PR, or an explicit user approval / Plan comment that records approval. Never treat leftover `Draft` alone as that evidence, and never auto-promote `## Status` from Draft to Approved just because the label is `status:approved`.
- Link an orphaned sub-issue to its obvious parent with `gh sub-issue add`.
- Remove a `blockedBy` edge whose blocker is closed or `status:verified`.
- Add a `blockedBy` edge that the issue body already states in prose.

**Tier 2: ask first.** These change what the roadmap says.

- When `status:approved` and `## Status` still says `Draft` (or otherwise disagrees) with no independent approval evidence: ask first. Conservative default is revert the label to `status:draft` (restore `phase:plan` if appropriate), not rewrite the body to Approved.
- Swap a `status:*` label to a different state.
- Reopen a closed issue, or close an open one.
- Mark an issue `status:blocked`.
- Merge duplicates, which means closing one and folding its content into the other.
- Convert a spec into an epic and create sub-issues.
- Change milestone or priority.

**Tier 3: never without explicit instruction.**

- Delete an issue.
- Bulk-relabel more than 10 issues in one action.
- Edit acceptance criteria on a `status:implemented` or `status:verified` issue.
- Close stale issues in bulk.

Batch the `gh` calls once approved, and report the exact commands run.

```bash
gh issue edit 142 --remove-label "status:approved" --add-label "status:implemented"
gh issue edit 161 --add-label "kind:spec"
gh issue edit 158 --remove-label "phase:build"
```

Fixing a body requires the round-trip from `references/conventions.md`: view to a temp file, edit, `gh issue edit --body-file`, delete the temp file.

## Step 5: Order the backlog

After corrections, produce the ready-to-work ordering.

```bash
gh issue list --label status:approved --state open --json number,title,labels,milestone,url
```

An issue is **ready** when:

- It is `status:approved`.
- It has usable acceptance criteria.
- It has an independently exercisable `## Demonstration` through a human, operator, or API/SDK public interface, or a justified minimal technical-enablement exception directly blocking the next user-facing slice.
- It is not `status:blocked`, and `gh issue view <N> --json blockedBy` returns no open blockers.
- Any dependency stated in prose in the body is also satisfied, whether or not it was recorded as an edge.
- No open PR already implements it.

Rank ready issues by:

1. Earliest demonstrable value: prefer the next user-facing slice. Put a technical-enablement issue immediately ahead of it only when the documented exception and direct dependency are valid.
2. Unblocking value: how many other issues depend on it.
3. Milestone or explicit user priority.
4. Age, oldest first, among equals.

Present the top few with the reason each is ranked where it is. Say plainly when two can run concurrently and when they would collide, based on the code paths each would touch, not just the issue text.

## Step 6: Report

Summarize:

- Scope groomed and how many issues were read.
- Corrections applied, by tier.
- Corrections proposed and awaiting approval.
- Blocking defects that stop Build or Verify.
- Recommended next issue, with the reason.
- Staleness decisions still owed by the user.

## Answering "what should we work on next?"

This is the short path through Triage. Run steps 1, 5, and 6 only. Skip the full defect scan, but still report any blocking defect on the issue you recommend, since it would stop Build immediately.
