---
type: Architecture
title: "Vercel session lifetime and terminal reconnect"
description: "Fixed VM-session timeout and session-derived tmux terminal reconnects."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/66
supersedes: 0008 idle policy
---

# Vercel session lifetime and terminal reconnect

## Decision

Each new Vercel Sandbox VM session receives one configured timeout. The
provider does not extend that deadline from terminal input, display checks, or
WebSocket pings. The same timeout applies when a retained snapshot creates a
new VM session.

The terminal shell parses `sandbox.currentSession().sessionId` into a branded
`VercelSessionId` and derives a socket directory under `/tmp/devbox-tmux`.
The directory uses a devbox-owned naming prefix and contains the tmux socket.
Before starting tmux, the shell removes only obsolete directories with that
prefix. It does not write a second ownership marker.

The terminal starts `tmux -S <session socket> new-session -A -s devbox -c <cwd>`.
The same VM session therefore uses one named tmux session across terminal
attachments. A forced WebSocket close or `Ctrl-]` releases the local transport
without stopping tmux. A later `--attach` reaches the same foreground process.

Snapshot resume remains the decision from ADR 0008. Vercel creates a new VM
session from the retained snapshot. The new session receives a new socket and
tmux server, so prior user processes end. Runtime setup, display services, and
public relays restart before the terminal opens.

## Consequences

- Terminal transport owns WebSocket framing, pings, resize, signals,
  backpressure, and cleanup. It does not choose tmux policy.
- Runtime preparation owns display and setup reconciliation. It does not
  create or inspect tmux sessions.
- Session identity comes from the provider session API, not `Sandbox.id`.
- The shell cleanup convention protects unrelated directories under `/tmp`
  from deletion.
- A session that reaches its configured timeout requires a new Vercel VM
  session. Terminal reconnect cannot extend its lifetime.

## Rejected alternatives

- Extending a timeout from terminal or display activity would make a detached
  terminal change the configured VM lifetime.
- One global tmux socket would mix processes from separate VM sessions and
  make snapshot boundaries unobservable.
- A marker file would duplicate ownership encoded by the socket directory
  naming convention.
