---
type: ADR
title: "noVNC access-code pairing"
description: "The printed display link carries a one-use access code that pairs the browser; Basic Auth is not used."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/7
---

# noVNC access-code pairing

## Decision

The Vercel display proxy authenticates browsers by **access-code pairing**, not
by HTTP Basic Auth. The `6080` link printed by `up`, `attach`, and `--url`
carries the branch access code as a `token` query parameter. The proxy checks
the code, sets an `HttpOnly; Secure; SameSite=Lax` cookie, and redirects to the
same path with the code removed. Later requests, including the WebSocket
upgrade, present only the cookie. Clients that arrive unpaired get a form that
accepts the same code, so a stale or truncated link is still recoverable.

The code and the cookie are stripped before anything is forwarded to
websockify, and both shapes are redacted from evidence artifacts.

**The printed link must work on click.** That is the property this ADR exists
to protect. Do not replace it with a credential prompt without superseding this
ADR.

## Context

This reverses the display-auth clause of
[ADR 0002](0002-vercel-provider-convergence.md), which specified fixed-username
Basic Auth with the password retrieved only through `--password`.

The history matters, because this design has now flipped twice:

1. `b2613d4` built the proxy with Basic Auth.
2. `8577f5a` replaced it with token pairing while addressing review findings on
   PR #11, 8 minutes before that PR merged. The change was never recorded as a
   decision, and the file kept the name `basic-auth-proxy.mjs`. That name is
   the reason this flipped: every later reader, human or agent, opened a file
   advertising Basic Auth and read the URL token as the defect. The file is now
   `images/vercel/novnc-proxy.mjs`.
3. `d7c3e08` — issue #7 work planned before that review fix — restored Basic
   Auth an hour later and wrote ADR 0002 in the same commit, ratifying a change
   nobody had asked for.

So the pairing design was undone not because it was reconsidered, but because
it existed only as code, inside a file whose name advertised the opposite, with
no record that it was deliberate. This ADR is that record.

## Alternatives rejected

- **HTTP Basic Auth.** Costs a separate `--password` invocation before the
  display can be opened, and the browser prompt cannot be satisfied by clicking
  the link that devbox just printed.
- **Credentials embedded in the URL for the whole session.** Leaves the secret
  in the address bar, in browser history, and in any `Referer`. Pairing avoids
  this by consuming the code on first use and redirecting it away.
- **No authentication on `6080`.** The port is public; the display grants
  interactive control of the box.

## Consequences

- The access code appears in the printed display link. It must not appear on
  any other surface: `list` and `stop` output never carry it, and the artifact
  redactors cover both `token=` and `devbox_novnc=`.
- `--password` remains as the way to retrieve the code for the pairing form —
  useful when opening the display on another device — but no flow requires it.
- `assertSafeRouteUrl` still rejects a query or fragment on the Vercel route
  itself. Pairing appends the code after that check, to the viewer URL.

## Verification

- Pairing, cookie exchange, URL scrubbing, rejection of a wrong code, and
  upstream credential stripping on both transports:
  [`tests/vercel-novnc-proxy.test.ts`](../../tests/vercel-novnc-proxy.test.ts).
- The code is confined to the display link and absent from `list`/`stop`
  output: [`tests/vercel-display-credentials.test.ts`](../../tests/vercel-display-credentials.test.ts).
- The shipped proxy implements pairing rather than Basic Auth:
  [`tests/vercel-image-assets.test.ts`](../../tests/vercel-image-assets.test.ts).
