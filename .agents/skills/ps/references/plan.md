# Plan

Produce a phased implementation plan grounded in the **Principles** section of this skill's `SKILL.md`. The plan is the deliverable. Do not implement.

Open a todolist with one item per step below.

## 0. Triage

Skip the plan when the change is one or two files with an obvious approach. Say so and stop.

Plan when the change spans three or more files, introduces architecture, has competing approaches or unclear scope, or the user asked for one.

## 1. Re-read principles

Read the **Principles** section of this skill's `SKILL.md` end to end, and the files under `references/principles/` it indexes. The principles govern every plan decision; cross-link them.

## 2. Scope and constraints

State your read of scope and constraints in one paragraph. Use the harness's ask-user tool only for genuinely ambiguous intent ([Never Block on the Human](references/principles/never-block-on-the-human.md)); give concrete options with each open question.

Resolve what is in scope vs explicitly out, technical or platform constraints, patterns to preserve, and the definition of done.

## 3. Explore in subagents

Delegate codebase exploration ([Guard the Context Window](references/principles/guard-the-context-window.md)).

- Spawn per `references/delegation.md`. A phase agent reads this skill's `SKILL.md` in full, including the Principles index, before doing any work. A generic planning agent that skips that read drifts.
- Pass `model:` explicitly per the configured roles (defaults `grok-4.6-fast-xhigh` for code, `claude-fable-5-thinking-max` for judgment).

Each explorer returns file pointers, conventions, dependencies, test infrastructure, and entry points. No inlined dumps.

## 4. Write the plan

The user specifies where the plan lives.

Single file `NN-slug.md` for small plans. For three or more phases, a directory with `overview.md` plus phase files:

```
NN-slug/
├── overview.md
├── phase-1-scaffold.md
├── phase-2-...md
└── testing.md
```

### Phase sizing

- One function or type plus tests, or one bug fix. Not "one file".
- Two to three files touched, max.
- Prefer eight to ten small phases over three to four large ones to preserve option value ([Foundational Thinking](references/principles/foundational-thinking.md)).
- Split if a phase has more than five test cases or three functions.

### Overview file

- **Context.** Problem and why now.
- **Scope.** Included; explicitly excluded.
- **Constraints.** Technical, platform, dependency, pattern.
- **Alternatives.** Two or three approaches sketched, choice and rationale ([Exhaust the Design Space](references/principles/exhaust-the-design-space.md)). Skip when constraints dictate one.
- **Applicable skills.** Domain skills the implementer should invoke, by name.
- **Phases.** Ordered standard-markdown links to phase files.
- **Verification.** Project-level commands.
- **Implementation guidance.** Per section 6.

### Phase files

- Back-link to overview.
- **Goal.** What the phase accomplishes.
- **Changes.** Files affected and the change at a high level. What and why, not how. No code snippets.
- **Data structures.** Name the key types or schemas. One-line sketch only ([Foundational Thinking](references/principles/foundational-thinking.md)).
- **Verification.** Per section 6.

Order phases so infrastructure and shared types land first ([Foundational Thinking](references/principles/foundational-thinking.md)). Each phase should be independently shippable.

For changes touching existing code, apply [Redesign from First Principles](references/principles/redesign-from-first-principles.md): if we'd built this with the new requirement on day one, what would it look like? Redesign holistically; deliver incrementally.

If a phase creates or edits a skill, the phase instructs the implementer to use the `skill-creator` skill.

## 5. Verification per phase

Each phase needs both:

**Static.** Type check, lint, project tests pass.

**Runtime.** Exercise the feature on the matching surface via the relevant control skill:

- Browser / Electron / Web UIs: the control-ui workflow (`references/control-ui.md`).
- CLIs and TUIs: drive the binary directly and assert on its output.
- CLIs, TUIs, and native mobile: the control-cli workflow (`references/control-cli.md`).
- Native mobile: whatever simulator-driving skill your team has.
- No control skill for the touched surface: flag it in the plan.

For bug fixes, the loop is reproduce on the surface, fix, verify on the same surface. Unit tests show a branch behaves a certain way; they do not prove the bug is gone ([Prove It Works](references/principles/prove-it-works.md)).

## 6. Implementation guidance

In the overview, name which of this skill's non-negotiables the implementer must apply, by name:

- the how workflow (`references/how/how.md`) over each unfamiliar subsystem before changing it.
- the interrogate workflow (`references/interrogate/interrogate.md`) for adversarial review on contested designs before shipping.
- The deslop workflow (`references/deslop.md`) over each diff before commit. The unslop workflow (`references/unslop.md`) over any prose surface.
- the show-me-your-work workflow (`references/show-me-your-work.md`) to keep a decision trail when the plan is large enough to need an auditable record.
- `references/playbooks/babysit.md` after opening the PR.

## 7. Hand back

Summarize phases, scope boundaries, applicable skills, and verification. Stop. The user decides when implementation starts.
