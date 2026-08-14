# Verify Workflow (GitHub)

Use this workflow to validate completed implementation against the spec issue's acceptance criteria, publish the evidence, open the pull request, and drive it to green.

Verify is the third phase in Plan → Build → Verify. It produces acceptance evidence, durable acceptance tests, a pull request, a converged CI and review state, and a signoff recommendation. Read `references/conventions.md` before starting.

## Autonomy contract

**Verify runs autonomously from entry until the stop condition.** Build enters this workflow directly without asking. Do not pause between steps to request permission, and do not hand control back after a single push or a single CI snapshot.

Run without asking:

- Capturing evidence and writing acceptance tests.
- Opening the PR.
- Diagnosing CI failures, fixing branch-related ones, committing, and pushing.
- Fixing valid review feedback from any reviewer, human or bot.
- Replying to and resolving review threads, human or bot.
- Re-entering the watch loop after every push.

**The stop condition is: CI green on the current head SHA, every review thread resolved or answered, no merge conflict, and the acceptance matrix complete.** On reaching it, stop and present the matrix for signoff. Do not merge; the user owns the merge decision (Step 9).

Stop early only for the conditions in "Stop and ask" at the end of this file. A push is never a terminal state. A single green snapshot while checks are still queued is never a terminal state.

## Step 1: Gather inputs

```bash
gh issue view <N> --json number,title,body,labels,state,url,comments
gh sub-issue list <N>          # if the issue is an epic
gh pr list --search "<N>" --state all --json number,title,state,url
```

Collect:

- The spec issue, ideally labeled `status:implemented`.
- The acceptance criteria checkbox list from the issue body.
- The Build completion report comment.
- The branch or PR to verify.

Run the phase-entry hygiene check from `references/conventions.md` and report findings. If acceptance criteria are missing or ambiguous, stop, add `needs:acceptance-criteria`, and return to Plan.

Mark the phase:

```bash
gh issue edit <N> --add-label "phase:verify"
```

If the user asks for UAT, signoff, merge readiness, or proof that work is complete, start here.

## Step 2: Verify against acceptance criteria

- Read `references/user-acceptance/workflow.md` completely and follow it to verify the **Acceptance criteria** from the issue body.
- Follow that workflow for evidence capture, UAT reporting, screenshots, recordings, command output, and human test guides.
- Use scripts under `scripts/user-acceptance/` when the workflow calls for them.
- Use an explicit **acceptance-criteria matrix** in the final report.
- Each criterion shows the verification method, result (`Pass`, `Fail`, `Blocked`, or `Not tested`), and evidence path or note. This keeps Verify tied to the approved scope instead of producing only a general UAT summary.

Evidence artifacts land under `uat-evidence/<target>-<timestamp>/` as described in that workflow. They stay on disk; `gh` cannot upload binaries to an issue. Reference their paths in the comment and tell the user which artifacts are worth attaching by hand.

## Step 3: Write durable acceptance tests

Evidence proves the criteria pass **now**. Tests keep them passing. Before opening the PR, encode every acceptance criterion that can be automated as a checked-in test.

- Add end-to-end or integration tests that assert the criterion's observable outcome, not the implementation detail that currently satisfies it.
- Name each test so the criterion it covers is obvious, and reference the issue number in the test file or describe block.
- Follow the repo's existing test layout and runner. Read `references/tdd/tests.md` for the standard on test quality.
- Run the full suite locally and make it pass before the PR exists. Opening a PR with a known-red suite wastes a CI cycle.

A criterion that cannot be automated (visual design, hardware interaction, third-party sandbox) stays evidence-only. Record it in the matrix with method `Manual` and say why automation was not possible. Do not write a hollow test that asserts nothing just to fill the row.

These tests are part of the branch and are pushed with it. They are what makes CI in Step 7 a real gate rather than a formality.

## Step 4: Adversarial evidence review

- Task a subagent to verify the `uat-evidence` and the new tests against the issue's acceptance criteria.
- Give the subagent the issue number so it can read the criteria with `gh issue view <N>` rather than trusting your summary.
- The subagent must not have produced the evidence it reviews.
- Fill in any gaps before posting the report. Gaps found here are cheaper than gaps found by a reviewer on the PR.

## Step 5: Post the acceptance evidence

```bash
MATRIX="$(mktemp -t pbv-verify).md"
# write the report to "$MATRIX"
gh issue comment <N> --body-file "$MATRIX"
rm -f "$MATRIX"
```

Start the comment with `## Verify: acceptance criteria matrix` and include:

- Scope line naming the branch, PR, or commit range verified.
- The matrix: criterion, method, result, evidence path.
- Totals (`6 Pass / 0 Fail / 1 Blocked`).
- Failures and blocked items with what would unblock them.
- Unrelated validation failures, separated from in-scope failures.
- Manual run instructions a human can follow.
- Recommendation line: `Pending user sign-off` until the user accepts.

## Step 6: Open the pull request

Evidence exists and the matrix is posted, so the PR can carry proof from the moment it opens.

```bash
PR_BODY="$(mktemp -t pbv-pr).md"
# write the PR body to "$PR_BODY"
gh pr create \
  --base <default-branch> \
  --head <branch> \
  --title "<issue title>" \
  --body-file "$PR_BODY"
rm -f "$PR_BODY"
```

The PR body must contain:

- `Closes #<N>` for the issue being implemented. For a sub-issue, close the sub-issue, not the parent.
- The acceptance-criteria matrix, or a link to the issue comment holding it.
- Scope, tasks completed, approved deviations, and the verification commands run.
- A link to the Build completion report comment.

If the repo merges without PRs, skip this step and Step 7, and say so.

## Step 7: Converge CI and review feedback

This is the autonomous loop. It runs until the exit condition, without asking permission between iterations.

### Loop

1. **Snapshot** PR, CI, and review state:

```bash
gh pr view --json number,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr checks --required --watch --fail-fast
```

`gh pr checks --watch` blocks until the checks finish and exits non-zero when one fails, so it is the wait itself, not a poll you have to schedule. Keep consuming its output in the same turn. Never background it and end the turn as if the work were done. Drop `--required` when the repo marks nothing as required.

2. **Review feedback first**, before CI reruns. A review fix produces a new commit that retriggers CI anyway, so fixing flakes on a SHA you are about to replace is wasted work.

 Build a ledger before editing anything. Enumerate every published review item, group related comments into issue candidates, and record `id`, `source` (author, path, line, thread URL), `reviewer ask`, `classification`, `evidence`, `action`, `disposition`.

 Follow `<path-to-skills-directory>/address-pr-comments/SKILL.md` for this step. It already runs autonomously and its comment-fetching script returns full thread state including resolved and outdated flags, which `gh pr view` does not expose. If that skill is not installed, read threads directly:

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100){ nodes{
          id isResolved isOutdated
          comments(first:50){ nodes{ author{login} body path line url } }
        }}
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F pr=<number>
```

 Classify each candidate against the **current** code, not the diff the reviewer saw: `fix`, `already-addressed`, `false-positive`, `question`, or `unsafe-to-change`. Every classification needs evidence.

 - `fix`: patch it, add a regression test when the comment describes recurring behavior, validate, commit, push, then reply and resolve the thread.
 - `already-addressed`, `false-positive`, `unsafe-to-change`: do not change code. Reply with the evidence-backed rationale and resolve.
 - `question`: answer it from the code and resolve.

 Reply to every thread you act on, human or bot, prefixed `[agent]` so authorship is unambiguous. Ignore reviews still in GitHub's `PENDING` state.

 **Never silently drop a review item.** A comment you decline still needs a posted rationale, or the PR looks ignored.

3. **Diagnose CI failures.** Read the logs before deciding anything:

```bash
gh run view <run-id> --log-failed
gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs    # single job, before the run finishes
```

 Classify branch-related versus flaky or infrastructural:

 - **Branch-related** — compile, test, lint, typecheck, or snapshot failures in code this branch touched. Fix, validate locally, commit, push.
 - **Flaky or infrastructural** — timeouts, runner provisioning, registry or network outages, Actions infra errors. Rerun, up to 3 attempts:

```bash
gh run rerun <run-id> --failed
```

 Do not edit tests, CI configuration, or dependency pins to make an unrelated failure disappear. That converts a red build into a hidden defect. If classification is ambiguous, diagnose manually once before rerunning.

 `gh run view --log-failed` is scoped to the whole run and may not expose logs until the run completes. If a single job has already failed while the run is still going, pull that job's logs directly rather than waiting.

4. **Check mergeability.** Resolve merge conflicts against the base branch by rebasing or merging, per repo convention.

5. **Re-enter the loop on the new SHA** after any push or rerun. Return to step 1 in the same turn.

### Exit condition

Exit only when all of these hold simultaneously on the **current head SHA**:

- Every required check is green. Not pending, not queued, not skipped-because-cancelled.
- Every review thread is resolved or has a posted reply.
- No merge conflict.
- The acceptance matrix has no `Fail` rows.

A green snapshot while checks are still running is not an exit. Re-poll and confirm.

### Abort condition

Stop the loop and report when:

- The flaky-retry budget (3) is exhausted on the same check.
- CI fails for reasons outside the branch that you cannot fix, such as an expired secret, a permissions error, or a provider outage.
- A reviewer asks for a change that contradicts the issue's acceptance criteria. That is a spec conflict: record it, stop, and return to Plan rather than quietly changing approved scope.
- The same check fails 3 times after 3 distinct fix attempts. Report the diagnosis instead of thrashing.

### Reporting cadence

Post progress updates, not a final summary, while the loop runs. Summarize status changes rather than every poll. Emit one update when CI first goes green on a SHA. Treat pushes, reruns, and resolved threads as progress, never as completion.

When the loop exits, update the issue with a `## Verify: convergence report` comment covering the final SHA, check results, commits pushed during convergence, the review ledger with each item's disposition, and flaky retries used.

## Step 8: Check off the acceptance criteria

For each criterion that passed, check its box in the issue body so the issue shows live acceptance progress:

```bash
BODY="$(mktemp -t pbv-body).md"
gh issue view <N> --json body -q .body > "$BODY"
# flip "- [ ]" to "- [x]" for passing criteria only
gh issue edit <N> --body-file "$BODY"
rm -f "$BODY"
```

Rules:

- Only check criteria with evidence in the matrix. A criterion checked without evidence is a false acceptance record.
- Leave failing, blocked, and untested criteria unchecked.
- Never edit the wording of a criterion during Verify. If a criterion is wrong, say so and return to Plan.

## Step 9: Signoff

**This is the first point since Build where the workflow stops for the user.** Everything before it ran unattended.

Present:

- The acceptance-criteria matrix with totals.
- PR link, final head SHA, and CI state.
- The review ledger: what was fixed, what was declined and why.
- Anything left manual or unverifiable.

Wait for explicit acceptance. Do not self-accept, and do not merge. Merging is the user's decision even when everything is green.

Once the user accepts:

```bash
gh issue edit <N> \
  --remove-label "status:implemented,phase:verify" \
  --add-label "status:verified"
```

Update the body's `## Status` section to `Verified` with a `Verified: <ISO 8601 datetime>` line.

Close the issue, unless a merged PR already closed it:

```bash
gh issue close <N> --comment "Verified and accepted. See the acceptance criteria matrix above."
```

If the user does not accept, leave the issue at `status:implemented`, record what is missing in the comment, and return to Build for the failing criteria.

## Step 10: Epic rollup

When the verified issue is a sub-issue:

1. Comment on the parent linking the child's matrix.
2. Check the parent's own acceptance criteria only when a parent-level criterion is genuinely satisfied by the child's evidence.
3. Clear the dependency edges this work unblocked. A verified issue should no longer block anything:

```bash
gh issue view <N> --json blocking          # what was waiting on this
gh issue edit <DEPENDENT> --remove-blocked-by <N>
```

 Leaving stale `blockedBy` edges makes the next Build stop on a blocker that is already done.

4. Run `gh sub-issue list <PARENT>` and check whether every child is `status:verified`.
5. If all children are verified, verify the parent's top-level acceptance criteria directly, then transition the parent to `status:verified` and close it.
6. If children remain, **continue autonomously into the next one.** Pick the first `status:approved` sibling with no open blockers, announce the choice, and re-enter `references/build.md` for it in the same session. Do not ask permission to continue the epic.

Stop and hand back only when no sibling is ready, when every remaining sibling is blocked, or when a "Stop and ask" condition applies.

Do not mark a parent verified because its children are done. The parent's own criteria still need evidence.

## Stop and ask

These override the autonomy contract. Stop and hand back to the user when:

- The spec issue cannot be found or is not `status:implemented`.
- Acceptance criteria are missing or ambiguous.
- Required credentials, services, or devices are unavailable.
- Verification would run destructive commands.
- The branch has unrelated changes that make evidence unreliable.
- The issue was already closed without a verification record.
- A reviewer requests a change that contradicts approved acceptance criteria.
- The convergence loop hit an abort condition in Step 7.
- A fix would require force-pushing over commits you did not create, or otherwise rewriting shared history.

Everything else is in scope to resolve without asking.

## Never

- Merge the PR. Signoff is the user's.
- Check off a criterion without evidence in the matrix.
- Edit the wording of an acceptance criterion to make it pass.
- Change tests, CI configuration, or dependency pins to hide an unrelated failure.
- Drop a review comment without a posted disposition.
- End the turn with the convergence loop unfinished and no abort condition reached.
