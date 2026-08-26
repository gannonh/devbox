---
type: Architecture
title: "Vercel snapshot resume and idle pause"
description: "Persistent pause, source-session evidence, runtime refresh, and heartbeat-based idle control."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/19
---

# Vercel snapshot resume and idle pause

## Decision

Vercel pause and stop use the persistent Sandbox stop operation with one
retained snapshot. Attach resumes that snapshot through `Sandbox.get({
resume: true })` and treats the result as a new session.

The runtime marker uses positive evidence. A running-session marker names the
Sandbox, current session, source revision, image digest, GitHub-token hash,
and environment hash. A snapshot marker names the Sandbox and source snapshot
with the same stable fields. Host metadata records the retained snapshot ID
and its source session because Vercel creates the snapshot after the filesystem
has been frozen, so the new ID cannot safely be written into that snapshot.

An exact running-session match takes the cheap attach path. A source-session
chain that matches the retained snapshot takes the fast resume path. That path
refreshes GitHub auth, dotenv state, Pi configuration, display services, and
recorded relays, then writes a new running-session marker. It never reclones,
installs dependencies, or reruns the post-create hook. Missing or mismatched
evidence takes the full path.

The remote heartbeat is mode `0600` and is updated by actual terminal input or
a successful display health poll. The idle controller uses a 15-minute
per-branch default, accepts zero to disable, and never treats WebSocket pings or
host-side attachment as activity. A newly snapshot-resumed session gets one
bootstrap heartbeat before the timer starts. It waits through the complete
window for a missing or unreadable heartbeat and does not pause while setup
status is `running`.

## Consequences

- Local pause is `docker pause`; local attach uses `docker unpause` without
  restarting the display.
- `--list` distinguishes running, paused, and stopped records. A Vercel
  stopped record is paused only when it has a retained snapshot.
- `--rm` includes the retained snapshot ledger and verifies cloud deletion
  before removing local metadata.
- A changed token or environment still refreshes runtime state, but it does
  not grant permission to skip stable source and image checks.

## Rejected alternatives

- `Sandbox.fork` would create a different lifecycle with unclear snapshot and
  retention semantics.
- Writing a newly returned snapshot ID to the frozen filesystem would require
  resuming it just to edit its marker and could silently change lifecycle state.
- A host-side TTY process or WebSocket ping would make background sessions look
  active after the user had stopped working.
