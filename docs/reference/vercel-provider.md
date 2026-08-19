---
type: Reference
title: "Vercel provider reference"
description: "Commands, configuration, credential precedence, public ports, and recovery rules."
status: Current
issue: https://github.com/gannonh/devbox/issues/7
---

# Vercel provider reference

## Commands

```sh
devbox --provider vercel <branch>
devbox --provider vercel <branch> --attach
devbox --provider vercel <branch> --url
devbox --provider vercel <branch> --password
devbox --provider vercel <branch> --stop
devbox --provider vercel <branch> --rm
devbox --provider vercel --list
```

`--provider` sticks to the repository: pass it once and later commands reuse it
until you pass `--provider` again, so `--provider local` is how you switch back.
The choice is stored per repository under the XDG state home, and a remembered
non-local provider prints a one-line notice before it runs, because the Vercel
provider creates billable resources and a default you cannot see is the kind
that surprises you.

In a Vercel terminal, `Ctrl-C` reaches the remote foreground process and
`Ctrl-]` detaches without stopping the Sandbox.

## Configuration and precedence

The complete `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` triad
wins. Otherwise `VERCEL_OIDC_TOKEN` supplies its encoded scope. Otherwise
device authorization requires the repository-root `.vercel/project.json`.
Partial triads and scope conflicts fail closed. Confirmed team/project IDs are
reused from mode-`0600` XDG state under `~/.local/state/devbox/providers/vercel`;
credentials are never written to the repository.

Vercel reads the existing `.devcontainer/devcontainer.json` `forwardPorts` and
`portsAttributes`. Only those app ports and the paired noVNC `6080` are public.
VNC `5900` and the internal noVNC listener are never exposed.

The printed `6080` link carries the branch access code as a `token` parameter.
Opening it pairs the browser: the proxy sets an `HttpOnly; Secure; SameSite=Lax`
cookie and redirects to the same path without the code, so the secret does not
remain in the address bar, in history, or in a `Referer`. The WebSocket upgrade
is authenticated by that cookie, and neither the code nor the cookie is
forwarded to websockify. An unpaired client gets a form that accepts the same
code; `--password` prints it:

```text
username: devbox
password: <generated-secret>
```

The code is generated with at least 128 bits of CSPRNG entropy. See
[ADR 0003](../adrs/0003-novnc-access-code-pairing.md).

## Runtime and cleanup

GitHub source is remote-first: dirty files and unpushed commits are excluded.
Secrets, `.env`, GitHub auth, and filtered Pi configuration are synchronized
at runtime only. Dependency installation and the post-create hook run in the
background; inspect `/vercel/.devbox/runtime/setup.status` and
`setup.log`, then retry with `bash /vercel/.devbox/runtime/setup.sh` after a
failure.

Stop waits for a terminal session and snapshot. Remove stops first, verifies
all sessions are `stopped`/`aborted`, deletes the Sandbox and its snapshots,
and relists until every matching snapshot is absent or `deleted`. A failed
cleanup retains non-secret scope/residual IDs in mode-`0600` metadata for
retry; metadata is removed only after verification.

Sandbox limits and pricing change over time; check the [official pricing and
limits](https://vercel.com/docs/sandbox/pricing) page before selecting a
timeout, region, port plan, or snapshot retention policy.
