# @gannonh/devbox

One command spins up an isolated Ubuntu dev container per git worktree, with a headed display viewable in your browser. Run multiple worktrees of the same repo concurrently with no port collisions.

Each box is a full developer environment: Node/Bun, git, gh, ripgrep, fd, fzf, tmux, a coding agent (Pi by default; Claude Code and Codex as one-line alternatives), and a headed display (Electron apps via noVNC in your browser).

## Quickstart

In any repo:

```bash
npx @gannonh/devbox init      # scaffold .devbox/ + .devcontainer/ config
npx @gannonh/devbox my-branch # boot a box for that branch, drop into a shell
```

Open the headed display in your browser (the `init` output and the ready banner show the URL, of the form `http://<container>.orb.local:6080/vnc.html`).

## What it does

- **One command, ready to work.** `npx @gannonh/devbox <branch>` creates a git worktree, builds the image, boots the container, and drops you into a shell in `/workspace` as a non-root user.
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
npx @gannonh/devbox init              # scaffold config into this repo
npx @gannonh/devbox <branch>          # boot (or re-enter) a box for a branch
npx @gannonh/devbox <branch> --attach # re-enter a running box
npx @gannonh/devbox <branch> --stop   # stop (keeps worktree + container)
npx @gannonh/devbox <branch> --rm     # remove container + worktree + branch
npx @gannonh/devbox <branch> --url    # print the noVNC URL
npx @gannonh/devbox <branch> --open   # open the noVNC URL in a browser
npx @gannonh/devbox --list            # list devbox containers + URLs
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

## Agents

`provision.sh` ships with three agent blocks — Pi active by default, Claude Code and Codex commented out:

| Agent | Package | Auth |
| --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent` | copied from host `~/.pi` |
| Claude Code | `@anthropic-ai/claude-code` | `ANTHROPIC_API_KEY` |
| Codex | `@openai/codex` | `OPENAI_API_KEY` or `codex --login` |

To switch, edit `.devbox/provision.sh` (comment-toggle the blocks) and remove the `~/.pi` mount from `.devcontainer/devcontainer.json`.

## Design spec

The package design is documented in [`docs/specs/2026-06-28-devbox-npm-package-design.md`](docs/specs/2026-06-28-devbox-npm-package-design.md).

## Status

Pre-release. The tooling is proven in production use; the standalone npm package is under active development per the design spec.

## License

[MIT](LICENSE)
