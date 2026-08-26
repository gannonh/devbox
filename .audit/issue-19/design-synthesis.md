# Issue 19 arena synthesis

## Pick

Candidate A is the base. Candidate B is grafted where it adds explicit box
states, a small idle evaluator, and local pause handling. The cross-judge chose
the same base.

## Why

Candidate A correctly models the irreversible snapshot boundary. A new snapshot
ID exists only after Vercel freezes the session, so it cannot be written into
that snapshot without resuming it. The source-session chain is the strongest
available proof.

Candidate B contributes the smaller public lifecycle surface. `--pause` is the
only new provider action and Vercel maps it to the existing persistent stop
operation. Local and Vercel state projection remain provider-owned.

## Grafts

- Use SDK `currentSession().sessionId` as session evidence, with a test-double
  fallback.
- Add `sourceSnapshotId` and snapshot source-session fields at the client seam.
- Keep snapshot IDs and idle policy in branch metadata, while preparation
  facts stay in the sandbox filesystem.
- Add local running, paused, and stopped transitions.
- Rebuild display and relay processes after snapshot resume.
- Use a pure clock and scheduler for idle decisions.
- Preserve all metadata fields during lifecycle writes.

## Rejected

- Writing a newly returned snapshot ID into the frozen filesystem.
- Treating the sandbox name as a session ID.
- Replacing the lifecycle with a broad entry-result hierarchy.
- Treating display polling, WebSocket health, or host attachment as user
  activity.
- Classifying every Vercel stopped row as paused.

## Cross-judge

The judge accepted Candidate A as the base and named the same Candidate B
grafts. It also rejected snapshot-only marker proof and broad lifecycle
rewrites.
