---
type: ADR
title: "Relay-backed public app routes"
description: "Publish a fixed-target HTTP/WebSocket relay per confirmed app port instead of the app's own listener, so an ordinary dev command works unedited."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/17
---

# Relay-backed public app routes

## Decision

**Expose a relay, not the app.** For every logical app port the user confirms,
devbox starts one small Node process inside the Sandbox and publishes *that*
process's port. The route the user is shown is still labelled with the logical
port; the listener behind it is the relay.

- A fresh Sandbox is created with `6080` only. Configured `forwardPorts` are
  parsed and validated at create time but are logical app ports, not listeners,
  so none of them reaches the create request.
- Each relay owns one immutable `relayPort → localhost:logicalPort` mapping,
  fixed from its environment at startup. A changed selection starts or stops
  processes; it never reconfigures a live one.
- Each relay binds `0.0.0.0:0`, checks what the kernel gave it against the
  display ports, the logical app ports, the Sandbox's other routes, and its
  siblings, and rebinds if the answer is unacceptable. The accepted socket is
  held from that moment, so the port cannot be taken between binding and
  publication.
- The relay rewrites `Host` to `localhost:<logicalPort>` and preserves `Origin`,
  cookies, and `Authorization`. It drops every client-supplied `Forwarded` and
  `X-Forwarded-*` field and states what it observed instead:
  `X-Forwarded-Host` from a syntactically valid incoming Host,
  `X-Forwarded-Proto: https`, and `X-Forwarded-For` from the socket peer.
- Nothing in a request can choose the upstream. Origin-form targets only, a
  400 for a malformed or absolute-form authority, and a hard refusal to target
  `5900`, `6080`, or `6081`. A relay is never given the display access code.
- Before the app listens, the public URL answers `502` within three seconds
  with a generic body of at most 256 bytes, once, with no retry loop. The same
  URL serves the app as soon as the app starts — no second route update.
- The transaction order is: desired relay listeners ready → Sandbox route
  update → metadata commit → obsolete relays stopped. Recovery under the branch
  lock commits only an exactly-matching desired state, restores the previous
  state otherwise, and treats a route it cannot verify as unverified.
- Committed metadata records the Sandbox identity, the selected logical ports,
  the `{ logicalPort, relayPort, label }` mappings, and the applied relay-port
  set. The raw-port record shape is replaced; an older one reads as absent.

## Context

[#13](https://github.com/gannonh/devbox/issues/13) made a normal repository's
app port public without devbox-specific configuration, and
[ADR 0005](0005-zero-config-public-app-ports.md) recorded that decision. UAT
against a real pnpm/Vite monorepo then found the last inch missing: the route
existed and the app was running, and the URL still did not work.

Two independent reasons, neither of which the app-port flow could fix:

1. An ordinary dev command binds loopback. A Vercel route needs an externally
   reachable listener, so the developer had to add `--host 0.0.0.0`.
2. Vite 5.4.12 and later reject an unknown `Host`. Vite 8 confirms
   `allowedHosts` is configuration-only for plain HTTP: there is no CLI flag
   and no environment variable devbox could set without editing the project.

ADR 0005 documented both as the app's job. That was the honest answer while
devbox exposed the app's own port — but it means "zero configuration" ends one
step before the thing the user actually wanted, and the workaround is
per-project and per-framework. A tunnel-shaped problem has a tunnel-shaped
answer, and the image already runs one: the authenticated noVNC proxy is the
same native `node:http`/`node:net` pattern.

## Rewriting Host is the decision, not an accident

The relay tells the app it is being reached at `localhost:<its own port>`. That
is precisely what makes an unmodified Vite dev server answer, and it is
deliberately a *narrower* change than the alternative.

The alternative was to keep exposing the app and tell every user to set
`server.allowedHosts` — that is, to switch off a host check globally rather
than satisfy it for one fixed local target. `Origin` is untouched, so the app's
own origin policy, CSRF defences, and cookie rules still see the real browser
origin and still decide. The host check is the only thing answered on the app's
behalf, and it is answered with the truth about the connection the app is
actually serving.

The routes are public either way. They were public before this ADR, behind the
same explicit confirmation from #13, and this decision adds no application
authentication — a relay is ingress compatibility, not an auth boundary.

## Why one fixed process per port

A single relay with a routing table would need a control plane: a way to add,
remove, and re-target mappings at runtime, which is a way to be told to reach
somewhere else. One process per mapping has none of that. Its target is an
environment variable read once at startup; the only way to change it is to
start a different process.

It also makes health a real question with a real answer. Each relay has a PID
and a start time recorded when it was launched, and the same evidence the
display stack uses decides whether a recorded mapping is live. A cheap attach
can then skip the repository scan and the prompt while still refusing to report
a route it has not checked.

## Port 0 is the allocator, and its answer is checked

The kernel is the only thing that knows which ports are free, so the relay asks
it. But "free right now" is not the same as "safe": the dev server that is
about to want `5173` is exactly the process that has not started yet, so an
unlucky ephemeral allocation could steal the app's own port. The relay
therefore refuses a kernel-chosen port that collides with a logical app port, a
display port, an existing route, or a sibling relay, and asks again — bounded,
because an unbounded retry is a different kind of failure.

A resumed Sandbox prefers the relay port its routes already name, so
reconstruction usually keeps the URL the user copied. It is a preference, not a
requirement: any route update regenerates every `*.vercel.run` subdomain
anyway, which is why every read surface re-reads routes rather than caching a
URL.

## Alternatives rejected

- **Tell users to set `allowedHosts` and `--host`.** Per-project, per-framework,
  and a change to their repository to satisfy devbox. It also generalizes badly:
  the next dev server with a host check needs its own instructions.
- **Detect Vite and pass flags.** Requires interpreting or rewriting the user's
  dev command, which ADR 0005 rules out for the same reason it refuses to
  evaluate `vite.config.ts`.
- **Launch the dev server for them.** A much larger trust decision, and wrong
  for anyone whose dev command is not what devbox would have guessed.
- **One relay with a routing table.** Adds a control plane and turns a fixed
  tunnel into something that can be asked to reach elsewhere.
- **Generic TCP forwarding.** For the Vercel provider these are HTTP/WebSocket
  app ports. A raw TCP path would be an exemption from the header contract, the
  400 on a malformed authority, and the bounded 502 — that is, an exemption
  from everything that makes the relay safe to publish.
- **Keep the raw port exposed as well.** The relay would then be optional and
  the app's listener would still be public, which is the state this replaces.
- **Support both metadata shapes.** A compatibility layer would let a record
  that describes routes to the app's own port survive an upgrade. Reading the
  old shape as absent takes the full provisioning path instead.

## Consequences

- `pnpm --filter web dev` — the project's ordinary command, unedited — serves
  through the printed public URL, and HMR works in a real browser.
- Route lines print the logical port and never the relay port. The join runs
  through the persisted mapping, so `--url` needs the metadata to say which app
  a route serves.
- An app that builds absolute URLs from `Host` sees `localhost:<port>`. Apps
  that need the public host should read `X-Forwarded-Host`, which the relay
  sets from the request. A per-route opt-out belongs in its own issue if a real
  application needs one.
- The relay ships as a runtime overlay, like the noVNC proxy, so a CLI newer
  than the pinned image carries its own copy.
- One app still costs one exposed slot, so ADR 0005's measured 14-route ceiling
  is unchanged.
- `--stop` tears the relays down before the Sandbox stops and keeps the record;
  `--rm` removes the Sandbox and everything inside it.

## Verification

- HTTP header contract, streaming, trailers, WebSocket upgrades, the bounded
  pre-listen 502, and the not-an-open-proxy cases, all against the real process
  over a real socket:
  [`tests/vercel-app-relay.test.ts`](../../tests/vercel-app-relay.test.ts).
- Start/status/stop, PID and start-time evidence, PID reuse, and the credential
  exclusion:
  [`tests/vercel-app-relay-control.test.ts`](../../tests/vercel-app-relay-control.test.ts).
- Provisioning, reuse, collision rejection, bounded retries, and teardown:
  [`tests/vercel-app-relay-manager.test.ts`](../../tests/vercel-app-relay-manager.test.ts).
- Selection, the publish/commit transaction, and every recovery branch:
  [`tests/vercel-app-port-flow.test.ts`](../../tests/vercel-app-port-flow.test.ts).
- 6080-only creation and relay teardown on stop:
  [`tests/vercel-lifecycle.test.ts`](../../tests/vercel-lifecycle.test.ts).
- Logical-port rendering and the cheap-attach reuse path:
  [`tests/vercel-url-output.test.ts`](../../tests/vercel-url-output.test.ts),
  [`tests/vercel-provider.test.ts`](../../tests/vercel-provider.test.ts).
- Real-Vercel proof against the pinned monorepo revision runs in the
  credentialed provider UAT workflow; see the
  [provider convergence runbook](../runbooks/vercel-provider-convergence.md).
