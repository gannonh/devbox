---
type: ADR
title: "Provider boundary for devbox lifecycle commands"
description: Keep CLI lifecycle routing provider-neutral while isolating Docker/devcontainer behavior in the local provider.
status: Accepted
issue: https://github.com/gannonh/devbox/issues/3
---

# Provider boundary for devbox lifecycle commands

## Decision

The CLI parses lifecycle actions and resolves a provider through the registry. A
`DevboxProvider` receives provider-neutral repository, branch, stream, and
runtime context and implements `up`, `attach`, `stop`, `remove`, `list`, URL /
open, and display-credential retrieval. Credential results use labeled
`username` and `password` fields, or an explicit unsupported result.

The existing Docker/devcontainer implementation is a focused local provider
under [`src/providers/local/`](../../src/providers/local/). The registry also
recognizes `vercel` so CLI grammar and provider-filtered lists are stable, but
this phase reports that Vercel is unavailable rather than importing an SDK or
claiming cloud support.

## Consequences

- Omitting `--provider` preserves local behavior.
- Provider-specific lifecycle formatting and errors remain inside providers.
- Future providers can implement the narrow approved contract without changing
  argument parsing or local command paths.
- Unsupported local display credentials are explicit and do not require
  capability negotiation.

## Verification

- Parser and registry permutations are tested without invoking provider
  internals in [`tests/cli-provider-routing.test.ts`](../../tests/cli-provider-routing.test.ts).
- Local command output remains injectable and is covered by
  [`tests/local-commands.test.ts`](../../tests/local-commands.test.ts).
