### Shipping

**You own what lands. Verify each PR independently, then merge only what carries a verdict.** For "ship it", "land this", "merge it", or the second half of work that **Babysit** already drove to green.

This is the half after `references/playbooks/babysit.md`. Babysit makes a PR mergeable. Shipping decides whether it is actually safe to merge. Green is not safe, and the gap between those two words is where this playbook lives.

1. **Verify every PR independently before merging anything.** One subagent per PR, not batched, per `references/delegation.md`. Each exercises the real surface the change touches (the browser, the CLI, the simulator) against base versus head, and returns `PASS`, `PASS+NOTES`, or `FAIL`. It posts that verdict on its own PR so the record outlives the chat. Safe means a verdict from an agent that did not write the code. CI green is not a verdict, and an approving bot review is not a verdict.
2. **Merge only what carries a passing verdict.** Both `PASS` and `PASS+NOTES` pass. `FAIL` or no verdict does not merge, whatever CI says. Report which PRs cleared and which did not, with the reason.
3. **Re-check that the verdict still describes the code.** A rebase onto moved trunk rewrites the SHA and silently invalidates a verdict without touching a single check. Compare `git patch-id` at the verdict SHA against the current head before trusting an older verdict, and re-verify anything that actually drifted. Twenty-one verdicts went stale this way in one run with no signal at all.
4. **Merge deliberately, one PR at a time.**
   ```bash
   gh pr merge <n> --squash --delete-branch
   ```
   Confirm the merge landed by reading the PR state back, not by assuming the command succeeded. If the repo requires a queue or auto-merge, arm it explicitly and confirm the field is on; never infer arming from a field that reads empty until the PR reaches the front.
5. **When PRs depend on each other, merge bottom-up and re-verify what moved.** Merge the base PR, let the dependent one rebase onto the new trunk, then re-run step 3 against it. A dependent PR verified before its base landed is carrying a stale verdict.
6. **Watch the merge, do not drive it.** Poll CI and the PR state until merged or a real failure appears. Re-arm the watch after any verdict you act on. If a merge stalls, diagnose before mutating, because a stalled queue and a broken branch look identical from the outside.
7. **Stop when the verified set is merged.** Report what landed, what is still unverified, and what verifying it would take. Extending the run is a new pass through step 1, not a judgment call you make at 3am.

**Reply:** each PR's verdict and who produced it, what you merged and how you confirmed it, what did not land, and what the next gap needs.
