# @gannonh/devbox

One command spins up an isolated Ubuntu dev container per git worktree, with a headed display viewable in your browser. Run multiple worktrees of the same repo concurrently with no port collisions.

Each box is a full developer environment: Node/Bun, git, gh, ripgrep, fd, fzf, tmux, a coding agent (Pi by default; Claude Code and Codex as one-line alternatives), and a headed display (Electron apps via noVNC in your browser).

Boxes run locally by default, or in a Vercel Sandbox in the cloud — see [Providers](#providers-where-the-box-runs).

## Quickstart

From this repo:

 ```bash
   npm run build
   node dist/cli.js --help
 ```

From any other repo:

```bash
npx @gannonh/devbox init      # scaffold .devbox/ + .devcontainer/ config
npx @gannonh/devbox my-branch # boot a box for that branch, drop into a shell
```

Open the headed display in your browser (the `init` output and the ready banner show the URL, of the form `http://<container>.orb.local:6080/vnc.html`). (Vercel boxes print an HTTPS display link instead; see [Providers](#providers-where-the-box-runs).)

## What it does

- **One command, ready to work.** `npx @gannonh/devbox <branch>` creates a git worktree from `origin/<default>` (after fetch; `DEVBOX_START_POINT=local` to use the local default instead), builds the image, boots the container, and drops you into a shell in `/workspace` as a non-root user.
- **Per-worktree isolation.** Each worktree gets its own container with its own network namespace, so concurrent worktrees never collide on ports. OrbStack exposes each container at `<container>.orb.local:<port>`.
- **Headed display via noVNC.** Xvfb + fluxbox + x11vnc + noVNC run inside the box; view the desktop in any browser. Electron apps render there.
- **Coding agent built in.** Pi is the default. Claude Code and Codex ship as commented-out blocks in `provision.sh` — switch by commenting out Pi and uncommenting your choice.
- **GitHub auth forwarded.** Your host `gh auth token` (macOS keyring) is forwarded into the box so `gh` and `git push` work without re-logging in.
- **Chromium + OAuth in the box.** `xdg-open` routes to Chromium (with the flags it needs under Xvfb), so OAuth flows that open a browser consent page complete entirely inside the container, visible via noVNC.

## Prerequisites

- **OrbStack** (or any Docker runtime; OrbStack gives you the `<container>.orb.local` URLs). [orbstack.dev](https://orbstack.dev)
- **`@devcontainers/cli`** — `npm i -g @devcontainers/cli`
- **`gh`** authenticated on the host — `gh auth login` (used to forward your GitHub token into the box)
- **git** (2.45+ for `worktree --relative-paths`)
- **Optional:** `~/.pi` on the host if you use the Pi agent (the box copies your config and extensions, excluding sessions/npm/cache)

## Commands

```bash
npx @gannonh/devbox init                              # scaffold config into this repo
npx @gannonh/devbox <branch>                          # boot a local box (default provider)
npx @gannonh/devbox <branch> --attach                # re-enter a running box
npx @gannonh/devbox <branch> --stop                  # stop (keeps worktree + container)
npx @gannonh/devbox <branch> --rm                    # remove container + worktree + branch
npx @gannonh/devbox <branch> --url                   # print current provider routes
npx @gannonh/devbox <branch> --open                  # open the first route in a browser
npx @gannonh/devbox --list                           # list local devbox containers
npx @gannonh/devbox --provider local --list          # filter list by provider

# Cloud boxes — see Providers below
npx @gannonh/devbox --provider vercel <branch>            # boot a Vercel Sandbox
npx @gannonh/devbox --provider vercel <branch> --password # print its display access code
```

## What `init` creates

```
.devbox/
  Dockerfile          # base image + tools + display stack + Chromium + agent
  provision.sh        # deps (lockfile-detected), .env link, agent setup, display
  start-display.sh    # idempotent Xvfb/fluxbox/x11vnc/noVNC startup
  post-create.sh      # opt-in hook for repo-specific steps (no-op stub)
  README.md           # per-repo guide
.devcontainer/
  devcontainer.json   # standard devcontainer config (works in Codespaces/Cursor too)
```

See [`.devbox/README.md`](.devbox/README.md) after `init` for the per-file rundown and the agent-switching instructions.

## Coding agents

`provision.sh` ships with three agent blocks — Pi active by default, Claude Code and Codex commented out:

| Agent | Package | Auth |
| --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent` | copied from host `~/.pi` |
| Claude Code | `@anthropic-ai/claude-code` | `ANTHROPIC_API_KEY` |
| Codex | `@openai/codex` | `OPENAI_API_KEY` or `codex --login` |

To switch, edit `.devbox/provision.sh` (comment-toggle the blocks) and remove the `~/.pi` mount from `.devcontainer/devcontainer.json`.

## Providers: where the box runs

A provider decides where `devbox <branch>` actually runs the box. `--provider`
picks one; omitting it keeps the local provider.

| Provider | Runs on | Reachable at | Source of your code |
| --- | --- | --- | --- |
| `local` (default) | your machine, via OrbStack/Docker | `<container>.orb.local:<port>` | the worktree on disk, uncommitted work included |
| `vercel` | a Vercel Sandbox in the cloud | HTTPS routes issued by Vercel | the authenticated GitHub origin — pushed commits only |

### Local containers (default)

The devcontainer path described above: one container per worktree, each with its
own network namespace, so concurrent worktrees never collide on ports.

### Vercel Sandboxes

Runs the box in Vercel's cloud rather than on your machine — no local Docker
runtime needed, and the display is reachable over HTTPS from anywhere.

```bash
npx @gannonh/devbox --provider vercel my-branch   # later commands reuse it
npx @gannonh/devbox my-branch --attach            # still Vercel
npx @gannonh/devbox --provider local my-branch    # switch back
```

The choice sticks to the repository until you pass `--provider` again. A
remembered Vercel provider prints a one-line notice before it runs, so a cloud
default is never silent.

Differences from a local box worth knowing before you start:

- **Remote-first source.** The Sandbox clones the authenticated GitHub origin,
  so dirty files and unpushed commits stay on your machine. Push first.
- **Confirmed scope on first use.** devbox prints the Vercel team and project
  and requires confirmation in a TTY. Credentials resolve in order: a complete
  `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` triad, then
  `VERCEL_OIDC_TOKEN`, then device auth scoped by `.vercel/project.json`.
  Confirmed scope is reused from mode-`0600` XDG state.
- **Display link pairs on click.** The printed `6080` link carries a one-use
  access code. Opening it exchanges the code for a session cookie and drops it
  from the address bar, so nothing else is needed to view the display. If you
  land on the pairing form instead — a stale or truncated link — `--password`
  prints the code to paste in.
- **Terminal keys.** `Ctrl-C` reaches the remote foreground process, and
  `Ctrl-]` detaches without stopping the Sandbox.

Commands, configuration precedence, and recovery behavior are in the
[provider reference](docs/reference/vercel-provider.md); the lifecycle and trust
boundary are in the [provider architecture](docs/architecture/vercel-provider.md).

#### What is exposed publicly

The app ports listed in your `devcontainer.json` `forwardPorts`, the
authenticated noVNC port `6080`, and any app port you accept at the prompt
described below. VNC `5900` and the internal noVNC listener are never exposed.
Dependency install and the post-create hook run in the background; their status
and retry script live in `/vercel/.devbox/runtime/`.

#### Zero-config app ports

A normal Vite or Next repository needs no devbox-specific port configuration.
After the remote checkout lands, devbox reads that checkout's root
`package.json` — dependencies and the root `dev` script only, as data, never
executed — and offers the conventional `5173`/`3000` port, or a literal port the
dev script names:

```text
Detected app ports in the remote checkout:
  candidate: 5173 (vite default)
  accepted app routes are PUBLIC: anyone with the URL can reach them
Expose the detected app port(s)? [Y/n/e=edit]
```

Enter accepts, `n` declines, and `e` edits the inferred list; configured
`forwardPorts` are always retained either way. The accepted ports are added to
the running Sandbox without recreating it, and the ready banner prints the
public URL. Outside a TTY nothing new is exposed unless you ask explicitly:

```bash
devbox my-feature --provider vercel --expose-ports 5173
```

The choice is remembered per branch and re-applied on `--attach` without asking
again.

devbox exposes the port; serving on it is your app's job, exactly as behind any
tunnel. Bind externally (`npm run dev -- --host 0.0.0.0 --strictPort`), and on
Vite 5.4.12+ also allow the generated host with
`server.allowedHosts: ['.vercel.run']` in `vite.config.*` — otherwise Vite
answers with `Blocked request. This host (…) is not allowed`. Next.js needs
nothing extra.

#### Why the runtime image is digest-pinned

A Sandbox boots from an OCI image, so devbox ships one carrying the display
stack and toolchain. The rule is **tags for development, digests for releases**:
a published package carries a digest frozen at publish time, so every Sandbox
runs the exact artifact its smoke evidence proves, while a git checkout follows
the `nightly` channel. Nothing in the source tree contains a digest, which is why
an image change is one pull request rather than two.

Set `DEVBOX_VERCEL_IMAGE` to a fully-qualified digest reference to run a locally
built image; it is refused against a published release. Channels, releases,
rollback, and orphan cleanup are in the
[image supply chain runbook](docs/runbooks/vercel-image-supply-chain.md).

## Testing providers against real infrastructure

*Maintainer-facing. These workflows run in this repository, not in projects that
install the package.*

Unit tests cover provider logic in isolation. Proving the Vercel provider end to
end needs live infrastructure and production credentials, so that work lives in
three workflows rather than on every push:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **CI** | every push and pull request | lint, typecheck, build, tests — no credentials |
| **Nightly** | scheduled on `main`, or dispatched at any ref | builds the image, runs publisher and consumer smoke gates, publishes a prerelease |
| **Release** | manual, default branch | promotes a proven nightly digest to `stable` and `latest`, gated by terminal smoke, UAT, and the five-run benchmark |

Pull requests never receive cloud credentials, and no label authorizes anything.
To prove a branch against real infrastructure, dispatch **Nightly** against that
ref; add `publish` to install it with `npx @gannonh/devbox@dev-<branch>`.

Credentialed runs still require the repository owner and the protected
`vercel-provider-smoke` environment. On a user-owned repository the owner is the
only possible authorizer, so environment review is effectively self-review — the
event guard is the real boundary.

### Required repository secrets

| Secret | Purpose |
| --- | --- |
| `VERCEL_CONSUMER_TOKEN`, `VERCEL_CONSUMER_TEAM_ID`, `VERCEL_CONSUMER_PROJECT_ID` | Verified Issue #4 consumer triad for the `devbox-uat` Sandbox project, shared with the image supply chain. The workflow maps them into the script environment as `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`; generic secrets under those names are never used. |
| `DEVBOX_GITHUB_FIXTURE_TOKEN` | Read-only token that can clone the private fixture. |
| `DEVBOX_GITHUB_FIXTURE_REPOSITORY` | Exact `owner/repository`. |
| `DEVBOX_GITHUB_FIXTURE_BRANCH` | Branch the `existing` path expects. |
| `DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH` | Expected GitHub API default branch. |
| `DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE`, `DEVBOX_GITHUB_FIXTURE_EXPECTED_CONTENT` | File and content assertion shared by both clone paths. |

### What a run verifies

The smoke uses the pinned `@vercel/sandbox@3.0.0` client and terminal adapter —
never a CLI shell-out — and runs every assertion and terminal session, including
resume/attach, in `/vercel/sandbox/<normalized-repository>`.

- **Clone** — `existing` clones the requested branch and allows a detached
  `HEAD`; `missing` clones the default branch and must create a run-unique local
  branch. Both assert the remote, exact `HEAD`, a clean worktree, and fixture
  content.
- **Terminal** — `openInteractive` once per adapter session, Ctrl-C, a
  post-interrupt marker, and production Ctrl-] escape detachment, through
  stop/snapshot completion of every created VM session.
- **Image** — a returned Sandbox image is accepted only when its manifest digest
  exactly matches the promoted pin; absent, tag-only, and different-digest values
  fail closed.
- **Cleanup** — preflight lists by a short smoke prefix and filters the complete
  five-tag identity locally. Each path's `finally` block reconciles its known
  Sandbox before independent collection recovery, paginates snapshot cleanup, and
  re-lists until every item is absent or `deleted`. Residual or unproven
  running-session state fails the run.

### Evidence artifacts and secret handling

Evidence records path labels and non-reversible fingerprints — never fixture
repository, branch, file, or content values, and never Vercel team or project
IDs. Artifacts upload after a final redaction step, including on a normal failed
smoke; a redaction failure withholds the directory rather than risk a leak.
Tokens travel only through the environment, headers, and in-memory SDK source
credentials — never command arguments, report fields, or files. For ambiguous
duplicates found during recovery, follow the manual recovery path in the
[image supply chain runbook](docs/runbooks/vercel-image-supply-chain.md) instead
of running `--rm`.

### Current state

A local provider-smoke invocation reaches credential validation and then fails on
absent configuration. That is not evidence of a provider execution: real provider
smoke runs only from a Release workflow call or an owner dispatch.

## Design spec

The package design is tracked in the [Vercel provider convergence issue](https://github.com/gannonh/devbox/issues/7) and the [OKF docs bundle](docs/index.md).

## Status

Pre-release. The tooling is proven in production use; the standalone npm package is under active development per the design spec.

## License

[MIT](LICENSE)
