---
type: Architecture
title: "Vercel session lifetime"
description: "Fixed VM-session timeout with no idle auto-pause or lease extension."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/65
supersedes: 0008 idle policy
---

# Vercel session lifetime

## Decision

Each new Vercel Sandbox VM session receives one configured timeout. The
provider does not extend that deadline from terminal input, display checks, or
WebSocket pings. The same timeout applies when a retained snapshot creates a
new VM session.

The default is 60 minutes. Same-session attach keeps the existing deadline.
Snapshot resume starts a fresh session with the stored timeout. Explicit
`--pause`, `--stop`, and `--rm` remain the only operator-owned early-stop
paths besides failed-setup cleanup.

When Vercel rejects Sandbox creation because the requested timeout exceeds
the captured provider limit, the CLI keeps the redacted cause and appends the
requested minutes, the documented Hobby 45-minute and Pro or Enterprise
24-hour limits, and a `--timeout 45` example. It does not guess the account
plan without that captured signature.

## Consequences

- Terminal transport owns WebSocket framing, pings, resize, signals,
  backpressure, and cleanup. It does not choose compute lifetime.
- Ready and attach output report the configured duration and, when Vercel
  returns it, the absolute `expiresAt` plus remaining time. Output does not
  invent an absolute deadline when the provider omits one.
- Obsolete local metadata that still carries the removed idle policy fails
  with an `--rm` and recreate instruction instead of a silent reinterpretation.

## Rejected alternatives

- Extending a timeout from terminal or display activity would make a detached
  terminal change the configured VM lifetime.
- Lowering the default to 45 minutes to fit Hobby would surprise Pro users.
  The documented hint covers Hobby rejection instead.
