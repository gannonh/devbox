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
`portsAttributes` as the explicit host-configuration path. Those ports are
always retained, and the paired noVNC `6080` is always exposed. VNC `5900` and
the internal noVNC listener are never exposed.

## Zero-configuration app ports

After the remote checkout is ready, Vercel scans it for app ports so a normal
Vite or Next project needs no devbox-specific configuration. The scan reads
`package.json` manifests as data — `dependencies`, `devDependencies`, and the
`scripts.dev` string of each. Nothing is executed and no script, source, or
`.env` text is printed.

It reads the repository root manifest, and, when the repository declares
workspaces, each member's manifest too. That second part is not an optimization:
a Turborepo or pnpm workspace keeps its root manifest as a task-runner shell
(`"dev": "turbo dev"`) with the actual app one level down, so a root-only scan
would find nothing in the most common monorepo layout. Members are discovered
from the `workspaces` field and/or `pnpm-workspace.yaml`, whichever the
repository uses. Only literal paths (`apps/web`) and single-level wildcards
(`apps/*`) are honored; `**`, negations, and traversals are dropped rather than
interpreted, and at most 16 patterns and 32 member manifests are read.

Candidates from a workspace are labeled with their path, so two apps in one
repository are never ambiguous:

```text
  candidate: 5173 (vite default — apps/web)
  candidate: 3001 (next dev script — apps/docs)
```

| Evidence | Candidate |
| --- | --- |
| `vite` in `dependencies`/`devDependencies`, or a `vite` command in `scripts.dev` | `5173` |
| `next` in `dependencies`/`devDependencies`, or a `next` command in `scripts.dev` | `3000` |
| A literal decimal port in `scripts.dev` as `PORT=`, `--port`, `--port=`, `-p`, or `-pN` | that port, overriding the default |

The grammar is literal: framework names must be exact dependency keys or
whitespace-delimited `vite`/`next` command tokens (optionally after `npx`), and
port values must be unquoted decimal tokens. Shell expansion, quoted values, and
ambiguous expressions produce no inferred override. When a dev script names more
than one port, both are offered as labeled candidates and one must be chosen
explicitly.

In a TTY, devbox lists the retained configured ports and the inferred
candidates, states that accepted app routes are **public**, and asks once.
Enter accepts, `n` rejects, and `e` edits the inferred set only — the edit
prompt can never drop a configured port. Accepted ports are applied to the
running Sandbox with a single full-port-list update; the Sandbox is never
recreated to add a route.

When the detector infers nothing, a TTY is still asked — the default inverted so
that Enter exposes nothing:

```text
No app ports were inferred from the remote checkout.
  accepted app routes are PUBLIC: anyone with the URL can reach them
  app ports to expose (comma-separated, Enter for none):
```

Detecting nothing is not the same as having nothing to expose: a layout the
grammar deliberately does not reach, or a server started by some other runner,
still has a port you know. A repository with no web app at all stays one
keystroke from booting, and the answer is remembered like any other, so you are
asked once per project state rather than on every boot.

Outside a TTY nothing new is ever exposed. The run reports the skipped
candidates and the exact opt-in, which is also how you script the behavior:

```bash
devbox <branch> --provider vercel --expose-ports 5173,3000
```

`--expose-ports` is valid only with a boot or `--attach`. It takes a non-empty
comma-separated list of decimal ports, refuses duplicates, `5900`, and the
internal noVNC port, and adds the requested app ports to the retained
configured set. The whole desired set is validated before anything is applied.

`--timeout <minutes>` and `--vcpus <n>` are create-only: they take effect on
the boot that creates the Sandbox. The parser also accepts them with
`--attach`, where they can only restate the stored values. `--timeout` sets the Sandbox timeout in minutes between 1 and 1440
(24 hours); the default is 60. `--vcpus` sets the Sandbox vCPUs, which must be
1 or an even number up to 32, with 2048 MB of memory per vCPU; Vercel defaults
to 2. Both are create-only configuration: they are stored in the branch's
metadata like the image digest, so a later boot or attach that changes one
conflicts instead of updating the Sandbox. To change either, `--rm` the box and
boot it again.

### The port maximum is 14, not 15

Three sources disagree about how many ports a Sandbox can expose, so devbox
uses the one that was measured against the live API:

| Source | Says |
| --- | --- |
| The installed `@vercel/sandbox@3.1.0` declaration comment | up to 15 |
| The request schema | refuses a 16th with `` `ports` should NOT have more than 15 items `` |
| The service | provisions 14; an update carrying exactly 15 fails with an opaque 500, repeatably and with any port values |

Devbox therefore caps the full set at **14 total ports — 13 app ports beside the
reserved `6080`** — and refuses a 14th app port with an actionable message
rather than letting the service return a 500. Reproduce the boundary with
`scripts/vercel/app-port-uat.mjs`.

### Route subdomains are regenerated by an update

Each exposed port gets a generated `*.vercel.run` subdomain, and a port update
re-issues them — including for ports that were already exposed. Devbox reads
the Sandbox's routes after the update, so the ready banner, the resume banner,
and `--url` always print current URLs, but a URL copied before an update can go
stale and return `SANDBOX_NOT_FOUND`.

### Your dev server must accept the sandbox host

Devbox exposes the port; serving on it is the app's job. Two settings are
usually needed, and neither is devbox-specific — the same two apply behind any
tunnel or reverse proxy:

- Bind externally, e.g. `npm run dev -- --host 0.0.0.0 --strictPort`.
- Allow the generated host. Vite 5.4.12 and later reject unknown `Host`
  headers with `Blocked request. This host (…) is not allowed`; add
  `server.allowedHosts: ['.vercel.run']` to `vite.config.*`. Next.js has no
  equivalent check and needs nothing.

The confirmed selection is stored without secrets in the branch's mode-`0600`
metadata together with the candidate fingerprint, the detector version, and the
remote `git rev-parse HEAD`. A resume with those values unchanged re-applies the
same routes without prompting; a changed project prompts again in a TTY, or
reports the change without new exposure outside one. Each route update is
written as a pending `{previous, desired}` record first and committed after, so
an interrupted update is reconciled against the Sandbox's actual routes on the
next attach — committed when already applied, cleared when never applied, and
otherwise restored to the previous set. An unknown route set is never treated as
committed.

Devbox never launches, rewrites, or relays your dev command. A route can exist
before the app starts, so bind the server externally yourself:

```bash
npm run dev -- --host 0.0.0.0 --strictPort
```

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

## Sandboxes another scope owns

A sandbox's identity hashes the repository, the branch, **and** the Vercel team
and project. Two boxes can therefore exist for one branch — one per scope — and
`--rm` only ever removes the one belonging to the credentials in use. Deleting
another team's resources is not this command's business.

`--rm` says so rather than reporting an empty result:

```text
No Vercel sandbox for my-feature in this team/project.
  1 sandbox(es) for this branch belong to another Vercel team/project and were not touched:
    devbox-vercel-v-0-1-2-github-com-acme-repo-my-feature-<hash>
  set VERCEL_TEAM_ID/VERCEL_PROJECT_ID to that scope and retry to remove them
```

`--list` does not mark which rows the current scope owns. Recomputing a row's
identity needs the exact branch string, and the branch tag cannot yield it back
for any branch containing a slash — `feature/ui` sanitizes to `feature-ui` but
hashes the original — so a marker would silently never fire for the commonest
branch shape and read as "every row is yours". Distinguishing them in the
listing needs a scope tag on the sandbox itself.

## Runtime and cleanup

GitHub source is remote-first: dirty files and unpushed commits are excluded.
Explicit `--env` values, GitHub auth, and filtered Pi configuration are
synchronized at runtime only. Dependency installation and the post-create hook run in the
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
