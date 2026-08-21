# Delegation

The only file that names a harness-specific mechanism. Every workflow defers here for how to spawn a subagent, which model a role gets, and how concurrent workers are kept apart.

## Roles

Workflows ask for a role, never a model slug. Five roles cover everything.

| Role | For | Used by |
|---|---|---|
| `explorer` | Recon and evidence gathering. Fast, cheap, high volume. | how explorers, why investigators, recall miners |
| `code` | Implementation. A precisely specified sequence of edits. | feature, refactoring, bug-fix delegates |
| `judgment` | Ambiguity, synthesis, prose, explanation, taste calls. | how explainer, why synthesizer, reflect, architect rationale |
| `panel` | A **list**. One subagent per entry, deliberately spanning model families. | interrogate reviewers, arena runners and cross-judge, how critics, architect runners |
| `worker` | Bulk parallel work across slices or races. | swarm |

## Which model a role gets

Read the `## Sub-agents` section of `AGENTS.md` (global instructions, already in context; on this machine the canonical file is `~/.agents/AGENTS.md` and every harness symlinks to it). Map its tiers onto the roles. Do not invent slugs, and never write a slug you have not confirmed is available.

Defaults when that section is absent or silent on a role:

| Role | Default | Escalation |
|---|---|---|
| `explorer`, `worker` | the roster's fast workhorse | none; drop the worker instead |
| `code` | the roster's fast workhorse | the roster's strongest instruction-follower when the work is a precise spec; the strongest judgment model when the intent is vague |
| `judgment` | the roster's strongest reasoning model at high thinking | its named fallback on provider failure |
| `panel` | one entry per distinct provider family in the roster | shrink the list, never substitute a duplicate family |

`panel` is the one role where the *list* matters more than any entry. The adversarial signal comes from model diversity, not from assigned personas. Models differ in blind spots, priors, and reasoning patterns. Agreement across families is high-confidence signal; a lone finding is worth reading at lower confidence. A panel of four same-family variants is close to worthless, so when the harness cannot span families, say so in the reply and weight the agreement signal down.

If a role resolves to "run on the parent model", omit the model argument rather than naming a slug.

## Mechanism per harness

Detect which one you are in and use it. Spawn every member of a fan-out in a **single message** so they run concurrently.

**Claude Code.** The `Agent` tool. `subagent_type` selects the agent (`general-purpose` unless a workflow names another), `model` takes `sonnet | opus | haiku | fable`, `isolation: "worktree"` gives a worker its own checkout. Agents run in the background and notify on completion; `SendMessage` continues one with its context intact.

Claude Code cannot span providers. Every `panel` here is same-family. Run it, and note the reduced diversity in the reply.

**pi.** The `subagent` tool from the `pi-subagents` extension. Fan out with a `workflowScript` calling `runs.all([{ key, agent, task }, ...])`; chain with `await runs.run(...)`. Built-in agents: `scout` (recon), `worker` (implementation), `reviewer` (review), `oracle` (second opinion, no edits), `researcher`, `delegate`. Override the model per run with `agent[model=provider/id:thinking]`. `isolation: "worktree"` for concurrent writers, `async` for background.

pi spans providers, so panels here get real diversity. Prefer it for `panel` work when more than one harness is available.

**Cursor.** The `Task` tool with `subagent_type` and `model`. Spans providers.

**No native mechanism.** Run the workflow inline, single-threaded, in the order the phases specify. Label the output so the reader knows it was not a real panel, and say which parts lost their independence.

## Waiting on something external

Run the task to completion. You do not need a wake mechanism to keep working, and reaching for one to pace yourself through your own task is wasted motion.

The exception is genuinely blocking on state you do not control: a CI run, a merge, a deploy. There, watch the thing itself. `<path-to-skill>/scripts/watch-pr/watch-pr` polls a PR to a terminal verdict and is the event wake for anything PR-shaped. For other external state, poll it directly and re-arm after each verdict you act on.

Only if a harness-level scheduler is genuinely needed (a check that must survive the session ending) reach for what the harness offers: the `loop` or `schedule` skills in Claude Code, `schedule` actions on pi's `subagent` tool, `/loop` in Cursor. Never run two sleep loops at once.

## Asking the user

Playbooks say "the harness's ask-user tool". That is Claude Code's `AskUserQuestion`, Cursor's `AskQuestion`, or pi's ask-user extension. Prefer it over free text: structured options are lower effort to answer and get better answers.

Where no such tool exists, ask in prose with the options enumerated. Either way, [Never Block on the Human](references/principles/never-block-on-the-human.md) still governs when to ask at all.

## Herdr mode

Only when the task was invoked with `--herdr`. Verify first:

```bash
test "${HERDR_ENV:-}" = 1
```

If that fails, say you are not inside Herdr and fall back to the native mechanism. Do not drive a Herdr session from outside it.

When it passes, follow the `herdr` skill. One uniquely named pane per worker, each running the coding agent that supports the role's model (`pi` for the full roster, `cursor-agent` for grok and composer, `codex` for gpt, `claude` for anthropic). Read state from the JSON the CLI returns rather than predicting it. `unknown` does not mean done.

Herdr buys visibility and hands-on control of long fan-outs. It costs setup and a pane per worker, so it is opt-in, never the default.

## Isolating concurrent writers

N workers writing one path is shared mutable state and fails [Separate Before Serializing Shared State](references/principles/separate-before-serializing-shared-state.md).

Give every writing worker its own destination, in this order of preference: a git worktree, then a branch, then `/tmp/ps-<slug>/worker-<n>/`. Read-only workers need nothing. State the destination in the brief; do not let a worker choose its own.

## Writing a brief

Every brief stands alone. The subagent does not see this conversation.

Include the goal, the scope, the exact slice or arm, how to verify, and what to report. Pass file paths rather than pasted file contents, per [Guard the Context Window](references/principles/guard-the-context-window.md). Reports come back as `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it. Do not silently rerun to fill the gap.
