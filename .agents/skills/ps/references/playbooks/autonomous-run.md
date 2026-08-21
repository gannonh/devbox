### Autonomous run

**You own the exit condition. Define done, then drive to it without stopping.** For "going to bed" / "run until done" / "loop until X".

1. State the exit condition as a checkable predicate before the first iteration (tests green, repro fixed, all N PRs merged, pixel-diff zero). A vague goal stalls; a predicate lets you stop.
2. Drive it in one run. You do not need a scheduler to keep working through your own task. The only thing to wait on is external state you do not control (CI, a merge, a ref advancing), and there you watch the thing itself per `references/delegation.md`.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help. Belt-and-suspenders that "might help" gets reverted, not left to ride.
   Sequence the work via [Sequence Work into Verifiable Units](references/principles/sequence-verifiable-units.md), verifying each unit before the next instead of batching checks at the end.
4. Mid-run discoveries are yours. Address broken skills, related bugs, flaky verifiers, review noise, tooling failures, orphaned follow-ups, and fixable drift yourself. Put out-of-band fixes in their own PR. Do not park reversible work for the human or stop to ask. Surface only irreversible actions, genuine product or preference calls no experiment can settle, or a real dead end. Keep the predicate as the main drive, and return to it after each side fix.
5. Checkpoint every iteration via the show-me-your-work workflow (`references/show-me-your-work.md`), a row for what changed and whether the predicate moved. A run with no trail can't be audited or resumed.
6. Stop when the predicate is met. A plateau is not a stop, so keep going and pivot your approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory.

**Reply:** the exit condition, iterations run, what landed, what was discarded, final predicate state.
