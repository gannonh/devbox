---
type: Architecture
title: "Vercel provider architecture"
description: "Provider boundaries, runtime data flow, security surfaces, and convergence gates."
status: Accepted
issue: https://github.com/gannonh/devbox/issues/7
---

# Vercel provider architecture

## Boundary

`src/cli.ts` parses provider-neutral lifecycle actions and dispatches through
`DevboxProvider`. The local provider owns Docker/devcontainer behavior. The
Vercel provider owns SDK auth, Sandbox identity, GitHub source selection,
runtime secret sync, display startup, public-port validation, terminal
transport, snapshots, and cleanup. No Vercel SDK type crosses into the local
provider.

## Data flow

1. Resolve the GitHub origin, requested/default remote branch, explicit `--env`
   values, filtered Pi bundle, explicit `forwardPorts`, and non-secret Vercel
   scope.
2. Create or resume a named persistent Sandbox from the fully-qualified
   digest-pinned image. The SDK receives a Git source; local dirty state never
   crosses the boundary.
3. Inject the explicit `--env` values, upload runtime-only state with mode
   `0600`, authenticate `gh`, start the display explicitly, and report setup as
   a separate background status.
4. Expose port `6080`, the configured app ports, and any app ports the user
   accepts from the bounded remote detector. `5900` and the internal noVNC
   listener remain private. The display proxy pairs a browser from the access
   code on the printed link, exchanging it for an HttpOnly cookie and
   redirecting the code out of the URL (ADR 0003).
5. Scan the remote checkout's root `package.json` for Vite/Next app ports,
   confirm them once, and apply the full desired port list through
   `Sandbox.update({ ports })` on the running Sandbox. The selection is bound to
   the candidate fingerprint, detector version, and remote `HEAD`, and is
   written pending-then-commit so an interrupted update is reconcilable.
6. Stop, resume, and remove use terminal session proof plus snapshot relisting.
   Metadata is removed only after cloud cleanup converges; residual IDs remain
   in a mode-`0600` retry record after partial cleanup.

```mermaid
flowchart LR
  CLI[CLI] --> Registry[Provider registry]
  Registry --> Local[Local provider]
  Registry --> Vercel[Vercel provider]
  Vercel --> Auth[Scope/auth resolution]
  Vercel --> Source[Remote GitHub source]
  Vercel --> SDK[@vercel/sandbox v3]
  SDK --> Image[Public digest-pinned VCR image]
  SDK --> Runtime[Runtime secrets/display/setup]
  SDK --> TTY[Interactive terminal]
  Vercel --> Detect[Bounded Vite/Next detector]
  Detect --> Confirm[Public-route confirmation]
  Confirm --> Update[Sandbox.update ports]
  SDK --> Routes[6080 + explicit + accepted app ports]
  Update --> Routes
  Runtime --> Routes
```

## CI and acceptance

Local quality runs on the supported Node 22 LTS lane.
Credentialed image, provider-UAT, and five-run benchmark workflows are
secret-gated, serialized by concurrency, and triggered only by an owner-
authorized PR, a default-branch manual dispatch, or the release workflow.
They redact evidence before upload and fail on residual Sandboxes, snapshots,
running sessions, leaked credentials, or a benchmark median above 10 seconds.

Official references: [Sandbox concepts](https://vercel.com/docs/sandbox/concepts),
[authentication](https://vercel.com/docs/sandbox/concepts/authentication),
[images](https://vercel.com/docs/sandbox/concepts/images), and
[pricing and limits](https://vercel.com/docs/sandbox/pricing).
