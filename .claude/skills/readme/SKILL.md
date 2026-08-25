---
name: readme
description: Write or rewrite a project README as plain factual documentation covering what the tool is, how to install and run it, what it touches, and how to undo it. Use when the user asks to create, write, rewrite, improve, or review a README, complains their README is too long, too marketing-heavy, or buries the install instructions, or says "make a README" / "fix my README".
---

# Readme

A README documents a tool. It states what the tool does, shows it running, and explains how to install, use, and remove it. It never persuades. If the facts are good, they carry the README; if they need dressing up, that is a signal about the tool, not a writing problem.

## Rules

1. **First line says what the thing is.** Plain declarative sentence: "Backup for sqlite databases, scheduled by cron." No problem/solution framing, no pain narrative, no "Tired of X?". A reader should know what they are looking at in five seconds.
2. **Show a real invocation early.** A command and its actual output beat any description. Copy from a real session, not an idealized one.
3. **Facts over adjectives.** Delete "powerful", "simple", "elegant", "blazing fast", "seamless". State the mechanism instead: not "lightning-fast search" but "searches 100k files in ~50ms (ripgrep)".
4. **Say what it touches.** Anything that runs code, registers hooks, writes files, or makes network calls gets stated next to the install command, along with how to disable or uninstall it. This is documentation of behavior, not a trust-building exercise.
5. **One mention per fact.** If install is documented in Install, do not repeat it elsewhere. Repetition reads as selling.
6. **Collapse depth with `<details>`, don't cut it.** Architecture notes, design rationale, and reference tables go inside `<details>` blocks with markdown inside (blank line after `<summary>`, blank line before `</details>`).
7. **No narrative voice.** No "I built this because...", no "What I learned", no origin story, no philosophy section up top. If design rationale matters, put a short note in a collapsed section.
8. **Order follows use.** What it is → Install → Usage/example → How it works → Reference/FAQ → License. A reader who wants to try the tool should never scroll past theory to find a command.

## Workflow

### 1. Gather context silently

Read what exists before asking anything: `README.md`, manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`), `LICENSE`, top-level source dirs. Infer name, language, install command, license.

### 2. Ask only what you can't infer

Batch remaining gaps into one round of questions, at most:
- One sentence on what the tool does (if the code doesn't make it obvious)
- A real command + output demonstrating it (or offer to run the tool to capture one)
- Whether it runs shell commands/hooks, writes outside the project, or makes network calls

Skip any question the repo already answers.

### 3. Generate

Write the README using the rules above. Structure serves the content, not a fixed template — a tiny CLI needs a fraction of what a framework needs. No emoji unless existing content uses them. Badges only if the repo already has them or the user asks.

For rewrites: keep accurate content, fix violations below, preserve anything the current README already does well.

### 4. Self-review before finishing

| Violation | Fix |
|---|---|
| Opens with a question, pain point, or "Tired of X?" | Replace with a plain statement of what the tool is |
| Problem/solution pitch structure | State what the tool does; skip the pitch |
| Adjectives without numbers ("fast", "simple", "powerful") | Replace with mechanism or measurement, or delete |
| Value repeated across sections | Keep the first factual mention, delete rest |
| Touches/hooks/network behavior undocumented | Document next to install, including uninstall |
| Same command documented in 3+ places | One usage section |
| Origin story or philosophy above examples | Move to collapsed details or delete |
| Idealized example output | Use real captured output |

Report which violations you found and fixed, so the user can veto intentional choices.
