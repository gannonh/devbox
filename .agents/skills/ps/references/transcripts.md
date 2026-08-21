# Transcripts

Where a harness keeps the session record. `recall`, `reflect`, `automate-me`, `show-me-your-work`, and the Session pickup playbook read it.

## Privacy rule, applies everywhere

Read only the **current workspace's** transcripts. Never glob across the whole projects directory. That crosses workspace boundaries and reads private chats from unrelated projects. When you need a transcript from another project, ask for the path rather than searching for it.

## Locations

Each harness encodes the working directory into a slug, then stores JSONL under it. Verified on this machine:

| Harness | Path | Slug encoding for `/Volumes/EVO/dev/skills` |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<session-uuid>.jsonl` | `-Volumes-EVO-dev-skills` (`/` becomes `-`, including the leading one) |
| Cursor | `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` | `Volumes-EVO-dev-skills` (leading `/` dropped, then `/` becomes `-`) |
| pi | `~/.pi/agent/sessions/--<percent-encoded-abs-path>--/` | `--%2FVolumes%2FEVO%2Fdev%2Fskills--` |
| Codex | `~/.codex/sessions/<year>/<month>/` | dated, not path-keyed. Filter by content or mtime |

Some harnesses name the active transcript directory in the system prompt. Prefer that over reconstructing a slug.

## Finding the current session

Newest-first within the resolved directory:

```bash
ls -t <transcript-dir>/*.jsonl <transcript-dir>/*/*.jsonl 2>/dev/null | head -10
```

Claude Code and Cursor also keep subagent transcripts one level deeper. Include `*/subagents/*.jsonl` when a workflow needs delegate output.

## When there is no transcript

Codex is dated rather than path-keyed, and some harnesses expose nothing. Say so and fall back to what is in context plus the shared record (commits, PRs, tickets). Do not fabricate a transcript reference, and do not present a reconstruction as if it were read from the log.
