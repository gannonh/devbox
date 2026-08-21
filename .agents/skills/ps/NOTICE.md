# Attribution

`ps` is adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (poteto), a Cursor plugin, used under the MIT License. The upstream license is in `LICENSE` and takes precedence over the repository-level license for this directory.

## What changed in this port

- Collapsed from a 44-skill Cursor plugin into one harness-agnostic skill. The former skills are `references/`, reached through the dispatch table in `SKILL.md`.
- All Cursor-specific delegation (`Task` tool parameters, `subagent_type`, `readonly`, cloud agents) replaced by `references/delegation.md`, which adapts to Claude Code, pi, Cursor, or no subagent mechanism at all.
- Model configuration moved from `~/.cursor/rules/pstack-models.mdc` to the `## Sub-agents` roster in `AGENTS.md`, maintained by `/ps setup`.
- Stacked-pull-request support removed. The `autopilot-stack` playbook is dropped, `shipping` and `autopilot` rewritten around independent PRs, and the `frontier` subcommand deleted from `scripts/orch`.
- Bugbot-specific triage generalized to any review bot, with CodeRabbit detection added to `scripts/watch-pr`.
- The `benny` Slack-automation pack was not ported.

## Substituted skills

pstack delegated to Cursor built-ins and to its sibling plugin `cursor-team-kit`, neither of which exists outside Cursor. Each hand-off was repointed:

| pstack used | Kind | `ps` uses |
|---|---|---|
| `create-skill` | Cursor built-in | `references/playbooks/authoring-a-skill.md`, or `skill-creator` if installed |
| `deslop` | cursor-team-kit | bundled as `references/deslop.md` |
| `control-ui` | cursor-team-kit | bundled as `references/control-ui.md` |
| `control-cli` | cursor-team-kit | bundled as `references/control-cli.md` |
| `/babysit` | Cursor built-in | `references/playbooks/babysit.md` |
| `/loop` | Cursor built-in | dropped. Agents run to completion; only external state is waited on, per `references/delegation.md` |
| `AskQuestion` | Cursor built-in | the harness's ask-user tool, resolved in `references/delegation.md` |

`deslop`, `control-ui`, and `control-cli` are vendored from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit), MIT, Copyright (c) 2026 Cursor. They are unmodified apart from stripped frontmatter. Vendoring them keeps `ps` a self-contained alternative stack rather than a wrapper that reaches into whatever else you happen to have installed.

`create-skill` has no bundled equivalent. It is Cursor-managed internal content with no license file and is not published in the public plugins repo, so it is not redistributable here. Skill authoring falls back to `references/playbooks/authoring-a-skill.md`, or the `skill-creator` skill if you have it.
