### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main; subagents inherit it. Multiple subagents on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Commits.** Commit liberally; rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit; new commit when separable.

**PRs.** Run the deslop workflow (`references/deslop.md`) on the diff before commit; the no-comments workflow (`references/no-comments.md`) before review; apply the unslop workflow (`references/unslop.md`) to the PR description and commit bodies. Small PRs, 5 narrow over 1 fat; branch off main. `gh pr view <number>` before referencing PR status. Rebase on `main` before substantial work. No `## Summary` / `## Test plan` boilerplate on small PRs; commit bodies don't restate the subject. After opening, run `references/playbooks/babysit.md`; push back when feedback drifts from intent.

A subagent that opens a PR runs the interrogate, deslop, and no-comments workflows, returns the URL, and does NOT babysit. Return to the parent.
