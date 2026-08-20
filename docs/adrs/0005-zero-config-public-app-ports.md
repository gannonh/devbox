---
type: ADR
title: "Zero-configuration public app ports"
description: "A bounded remote package.json detector, one public-route confirmation, and a pending/commit port update bound to the checkout revision."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/13
---

# Zero-configuration public app ports

## Decision

**Detect from remote metadata, confirm once, update in place, and bind the
result to the exact checkout.**

- The detector reads exactly three fields of the remote checkout's root
  `package.json` — `dependencies`, `devDependencies`, and `scripts.dev` — as
  data. No script or config is executed, no workspace is traversed, and no
  script, source, or `.env` text leaves the detector; callers receive
  `{ port, framework, source }` records only.
- Its grammar is literal. Frameworks are exact dependency keys or
  whitespace-delimited `vite`/`next` command tokens (optionally after `npx`);
  ports are unquoted decimal tokens in `PORT=`, `--port`, `--port=`, `-p`, or
  `-pN` form. Anything else — expansion, quoting, a non-decimal value — yields
  no inferred override rather than an interpretation.
- Detected ports are **candidates**, never exposure. A TTY sees one prompt that
  says the routes are public; outside a TTY nothing new is exposed without
  `--expose-ports <list>`.
- Configured `forwardPorts` remain the trusted, always-retained path. Candidates
  are additive, and neither rejecting nor editing them can drop a configured
  port.
- Accepted ports reach the running Sandbox through
  `Sandbox.update({ ports: <full desired list> })`. Nothing is recreated.
- The selection is stored with the candidate fingerprint, the detector version,
  and the exact remote `git rev-parse HEAD`, so a resume re-applies it silently
  and a changed project asks again.
- Each update is written as a pending `{ previous, desired }` record first and
  committed after. Recovery compares the Sandbox's **actual** routes against
  both records and commits, clears, or restores — never assumes.

## Context

Phase 4 derived app ports only from the host checkout's
`.devcontainer/devcontainer.json`, so a normal Vite or Next repository could not
show its own app until someone added devbox-specific configuration to it. That
is the opposite of the product's premise.

Two constraints shaped the design. The remote-first contract from
[#2](https://github.com/gannonh/devbox/issues/2) means local dirty state must
not decide what becomes public, so detection has to read the checked-out tree
inside the Sandbox. And a public route is an irreversible-feeling act: the URL is
reachable by anyone who has it. Those together rule out both "guess and expose"
and "read the developer's working tree."

The detector is deliberately dumb. A smarter one — evaluating `vite.config.ts`,
resolving workspaces, running `npm run dev --dry-run` — would be more accurate
and would also mean executing repository code to decide what to make public.
Refusing to interpret is the security property, not a limitation to fix later.

## The port maximum is 14, and only measurement found that

Three sources disagreed:

| Source | Says |
| --- | --- |
| The installed `@vercel/sandbox@3.0.0` declaration comment | up to 4 |
| The request schema | refuses a 16th: `` `ports` should NOT have more than 15 items `` |
| The live service | provisions 14; exactly 15 fails with an opaque 500 |

The 500 reproduced on every attempt, with different port values. Devbox caps the
full set at 14 (13 app ports beside the reserved `6080`) so an over-large set
fails with an actionable message instead of surfacing an internal error. This is
why the ticket required a live boundary check rather than a documentation
reading, and it is the reason the cap is a measured constant with the evidence
recorded next to it.

## Alternatives rejected

- **Expose detected ports automatically.** A false positive is a public URL. The
  confirmation is the whole safety property.
- **Recreate the Sandbox with the new port set.** Destroys the running
  workspace to add a route, when the API supports updating one in place.
- **Store only the selected ports.** Without the fingerprint and revision, a
  resume cannot tell "same project, same answer" from "different project,
  stale answer," so it would either re-prompt every time or silently re-expose
  a port the project no longer uses.
- **Commit the selection before updating.** A crash would then leave metadata
  claiming a route that does not exist. Pending-first means the untracked
  direction is the safe one: a route that exists is always described by a
  record.
- **Launch the dev server, or relay loopback to the public port.** Out of scope
  and a much larger trust decision; devbox exposes the port and says so.

## Consequences

- A normal Vite or Next repository works with no devbox-specific configuration,
  which was the point.
- Serving on the route stays the app's job. Binding externally is required, and
  Vite 5.4.12+ additionally rejects the generated host until the project sets
  `server.allowedHosts`. Documented rather than worked around, because it is
  identical behind any tunnel.
- A port update regenerates every route's subdomain, so a URL copied before an
  update goes stale. Devbox re-reads routes after updating and always prints
  current URLs.
- Adding a framework means adding a defaults entry and, if it changes the
  grammar, bumping `APP_PORT_DETECTOR_VERSION` — which re-prompts every stored
  selection rather than reusing an answer the old grammar produced.

## Verification

- Detector grammar, token boundaries, overrides, conflicts, malformed and
  ambiguous metadata, and fingerprint stability:
  [`tests/vercel-app-ports.test.ts`](../../tests/vercel-app-ports.test.ts).
- Remote scan bounds, missing/malformed `package.json`, and redaction:
  [`tests/vercel-app-port-scan.test.ts`](../../tests/vercel-app-port-scan.test.ts).
- Prompt decisions, edit validation, and conflicting-candidate handling:
  [`tests/vercel-app-port-prompt.test.ts`](../../tests/vercel-app-port-prompt.test.ts).
- Selection, union with configured ports, limits, persistence, resume,
  non-interactive behavior, and every recovery branch:
  [`tests/vercel-app-port-flow.test.ts`](../../tests/vercel-app-port-flow.test.ts).
- The exact `update({ ports })` request, full-list replacement against the mock
  server, and the pinned `3.0.0` contract:
  [`tests/vercel-client.test.ts`](../../tests/vercel-client.test.ts).
- Real Vercel end to end, including the measured port boundary and
  metadata-failure compensation:
  [`scripts/vercel/app-port-uat.mjs`](../../scripts/vercel/app-port-uat.mjs).
