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

`--provider` is explicit; omitting it keeps the local provider. In a Vercel
terminal, `Ctrl-C` reaches the remote foreground process and `Ctrl-]` detaches
without stopping the Sandbox.

## Configuration and precedence

The complete `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` triad
wins. Otherwise `VERCEL_OIDC_TOKEN` supplies its encoded scope. Otherwise
device authorization requires the repository-root `.vercel/project.json`.
Partial triads and scope conflicts fail closed. Confirmed team/project IDs are
reused from mode-`0600` XDG state under `~/.local/state/devbox/providers/vercel`;
credentials are never written to the repository.

Vercel reads the existing `.devcontainer/devcontainer.json` `forwardPorts` and
`portsAttributes`. Only those app ports and authenticated noVNC `6080` are
public. VNC `5900` and the internal noVNC listener are never exposed. Public
URLs contain no credentials. Retrieve the display credential explicitly:

```text
username: devbox
password: <generated-secret>
```

The display proxy rejects missing or incorrect HTTP/WebSocket Basic Auth. The
password is generated with at least 128 bits of CSPRNG entropy.

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
