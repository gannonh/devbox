---
name: devbox
description: Boot and operate isolated per-branch dev containers with a headed display (noVNC), Pi/Claude Code/Codex agent, Chromium for OAuth, and GitHub-token forwarding. Use this skill whenever the user wants to work on a branch in an isolated container, run or test GUI/Electron apps headlessly via a browser-viewable display, do OAuth flows inside a container, spin up a clean per-branch environment, or use `npx @gannonh/devbox` / `devbox`. Also trigger when the user mentions devbox, dev containers per worktree, noVNC dev boxes, or wants isolated environments that don't pollute their host. Even if they don't say "devbox" explicitly, reach for it when they describe wanting a fresh, throwaway, or isolated environment for a branch or feature.
---

# devbox

devbox gives every git branch its own isolated container with a headed display (viewable in a browser via noVNC), a coding agent, Chromium for OAuth flows, and GitHub-token forwarding. One command boots a box; teardown is one command too.

## When to use devbox

Reach for devbox when the user would benefit from a clean, isolated, per-branch environment:

- They want to work on a branch without messing up their host install or other branches.
- They need to run or test a GUI/Electron app and see it (noVNC renders the display in a browser).
- They're doing an OAuth flow that needs a browser callback, and want it contained.
- They want a fresh `node_modules`/build state that doesn't conflict with the main checkout.
- They explicitly say "devbox", "isolated container", "per-branch environment", or use `npx @gannonh/devbox` / `devbox`.

devbox is **not** the right tool for running the project's unit tests on the host, editing files outside a worktree, or one-off shell commands. It boots a full container, so prefer it when isolation or a display actually helps.

## Prerequisites (host)

These live on the host, not in the box. Check them before booting a box for the first time in a repo:

- **Docker / OrbStack** — OrbStack on macOS is recommended (auto-exposes container ports at `<container>.orb.local:<port>`). Any Docker runtime works.
- **@devcontainers/cli** — `npm install -g @devcontainers/cli` (provides the `devcontainer` command devbox drives).
- **gh (GitHub CLI)** — `gh auth login` on the host. devbox forwards `gh auth token` into the box so `gh` and `git push` work without re-auth. Without it, the box still boots but `git push` will need in-box auth.
- **~/.pi (optional)** — only if using the Pi agent (the default). Claude Code and Codex don't need it.

If a prerequisite is missing, tell the user exactly what to install and don't attempt to boot the box until it's resolved.

## First time in a repo: `devbox init`

If the repo has no `.devbox/` directory, run init first. It scaffolds `.devbox/` (Dockerfile, provision.sh, start-display.sh, post-create.sh, README.md) and `.devcontainer/devcontainer.json`.

```sh
npx @gannonh/devbox init
```

init prints a customization guide pointing at the repo-specific surfaces. The templates are mostly generic; only a few files are meant for per-repo edits:

- **`.devbox/post-create.sh`** — the repo-specific hook. Add migrations, native builds, seed data, extra tool installs here. No-op by default.
- **`.devcontainer/devcontainer.json`** — `forwardPorts`/`portsAttributes` default to Vite (5173), RPC (9100), noVNC (6080). Adjust to the repo's dev servers. Add Features or `containerEnv` here too.
- **`.env`** (repo root) — provision.sh links it into the box as `/home/node/.env`. Put secrets here (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).
- **`.devbox/provision.sh`** — agent switching only (see below). Otherwise generic; don't edit for repo setup.
- **`.devbox/Dockerfile`** — extra apt packages, rarely needed.

Read `.devbox/README.md` for the full per-file guide.

## Boot a box for a branch

```sh
npx @gannonh/devbox <branch>
```

This creates a git worktree for the branch, boots the container, provisions it (installs deps from the lockfile, sets up the agent, starts the display), and drops into a shell in `/workspace` as the non-root `node` user. The first run pulls the base image and provisions, so it takes a few minutes; subsequent boots are fast.

If a box for the branch is already running, this re-enters it. If it's stopped, it starts it and re-brings the display up.

### Seeing the display

The CLI prints the noVNC URL when the box is ready. To open it:

```sh
npx @gannonh/devbox <branch> --url --open
```

Or browse to `http://<container-name>.orb.local:6080/vnc.html` (OrbStack) manually. This is how you see GUI/Electron apps running in the box.

## All the commands

| Command | What it does |
|---------|--------------|
| `devbox init [--force]` | Scaffold `.devbox/` + `.devcontainer/` in the current repo. `--force` overwrites differing files. |
| `devbox <branch>` | Boot a box for a branch (or re-enter if running). |
| `devbox <branch> --attach` `-a` | Re-enter a running box. Starts + re-brings display if stopped. |
| `devbox <branch> --stop` | Stop the box (keeps worktree + container on disk). |
| `devbox <branch> --rm` | Remove container, worktree, and branch. Uncommitted worktree work is lost. |
| `devbox <branch> --url` | Print the noVNC URL. Add `--open` `-o` to launch a browser. |
| `devbox --list` `-l` | List all devbox containers for this repo with state + noVNC URLs. |
| `devbox --help` `-h` | Show usage. |

`devbox` is the installed bin; `npx @gannonh/devbox` works without a global install. Use whichever fits the user's setup.

## Inside the box

- The worktree is bind-mounted at `/workspace`; you're in `/workspace` as `node`.
- `.env` from the host is linked at `/home/node/.env`.
- `GH_TOKEN` is exported in every shell (forwarded from host `gh`), so `gh` and `git push` work.
- The display (Xvfb + x11vnc + noVNC) runs detached via `setsid` and survives container restarts.
- Chromium is wrapped to pass `--no-sandbox --disable-gpu --test-type` so it launches under Xvfb. `xdg-open <url>` routes to it, which is how in-box OAuth works (a `localhost` callback is reachable in the shared network namespace).
- `DEVBOX_ELECTRON_NO_SANDBOX=1` is set so Electron launches with `--no-sandbox`. The repo's Electron dev script should read this env var and pass `--no-sandbox` when set.

## Agent switching

The box ships with the **Pi agent** active. To switch to Claude Code or Codex:

1. Edit `.devbox/provision.sh`: comment out the Pi block (section 4a), uncomment 4b (Claude Code) or 4c (Codex).
2. Edit `.devcontainer/devcontainer.json`: remove the `~/.pi` mount line (inert for non-Pi agents, and `~/.pi` is ~1.3GB).
3. Set the agent's key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) in `.env` or `devcontainer.json` `containerEnv`. For Codex, `codex --login` inside the box also works (opens Chromium).

Re-provision by removing the box (`devbox <branch> --rm`) and booting again, since provision runs at create time.

## How to decide what to run

If the user is vague ("set up a dev environment for this branch"), walk the decision:

1. No `.devbox/`? Run `init` first.
2. Want to work on branch `X`? `devbox X`.
3. Need to see a GUI? `devbox X --url --open`.
4. Done with the branch? `devbox X --rm` (warn that uncommitted worktree work is lost).

Don't boot a box for tasks that don't need isolation or a display, that's wasteful. If the user just wants tests run on the host, use the host.

## Installing this skill

This skill can be installed into a repo so every collaborator's agent picks it up:

```sh
npx skills add gannonh/devbox --skill devbox -y
```

It lands at `.agents/skills/devbox/SKILL.md`. `devbox init` also offers to install it automatically.
