# devbox

Isolated worktree dev containers with a headed display (noVNC), Pi agent,
Chromium for OAuth flows, and GitHub-token forwarding. One command per branch.

## Quickstart

```bash
# 1. Initialize devbox in your repo (creates .devbox/ + .devcontainer/)
npx @gannonh/devbox init

# 2. Boot a box for a branch
npx @gannonh/devbox my-feature

# 3. View the headed display in your browser
#    The CLI prints the noVNC URL, or use:
npx @gannonh/devbox my-feature --url --open
```

Each branch gets its own isolated container with its own network namespace
(no port collisions). The worktree is bind-mounted at `/workspace` inside the
box, and you drop into a shell as the non-root `node` user.

## Prerequisites

- **Docker / OrbStack** — [OrbStack](https://orbstack.dev) recommended on
  macOS (auto-exposes container ports at `<container>.orb.local:<port>`).
  Any Docker runtime works; non-OrbStack falls back to container IPs.
- **@devcontainers/cli** — the CLI that drives `devcontainer up`:
  ```bash
  npm install -g @devcontainers/cli
  ```
- **gh (GitHub CLI)** — for GitHub token forwarding into the box. Auth it on
  your host:
  ```bash
  gh auth login
  ```
  The launcher pulls `gh auth token` from your host keyring and forwards it
  into the box so `gh` and `git push` work without re-auth.
- **~/.pi (optional)** — if you use the Pi coding agent, your `~/.pi` config
  is copied into the box (excluding sessions/npm/cache) and extensions are
  rebuilt Linux-native. If you use Claude Code or Codex instead, see
  [Agent switching](#agent-switching) below.

## Files

| File | Purpose |
|------|---------|
| `.devbox/Dockerfile` | The container image: TypeScript-Node base + bun, gh, ripgrep/fd/fzf/tmux, display stack (Xvfb/x11vnc/noVNC/fluxbox), Chromium, and the Pi agent. Built locally per repo. |
| `.devbox/provision.sh` | Runs once at container create: installs repo deps (auto-detects bun/pnpm/npm from lockfile), links `.env`, sets up the agent (Pi by default), and starts the display. |
| `.devbox/start-display.sh` | Starts Xvfb, fluxbox, x11vnc, and noVNC. Runs on every container start via `postStartCommand`. Idempotent. |
| `.devbox/post-create.sh` | Repo-specific hook. Add custom setup here (migrations, native builds, etc.). Runs after provision.sh. No-op by default. |
| `.devcontainer/devcontainer.json` | Standard devcontainer config read by `@devcontainers/cli`, Codespaces, and Cursor. Defines mounts, env vars, lifecycle hooks, and ports. |

## Agent switching

The box ships with the **Pi agent** active by default. To switch to **Claude
Code** or **Codex**:

1. Edit `.devbox/provision.sh`:
   - Comment out the Pi block (section 4a).
   - Uncomment the Claude Code block (4b) or Codex block (4c).

2. Edit `.devcontainer/devcontainer.json`:
   - Remove the `~/.pi` mount line. It is inert for non-Pi agents and `~/.pi`
     is ~1.3GB, so removing it avoids a wasteful mount.

### Claude Code

- Package: `@anthropic-ai/claude-code` (installed via `npm install -g`)
- Auth: set `ANTHROPIC_API_KEY` in your `.env` file or
  `devcontainer.json` `containerEnv`
- No config-dir copy needed — Claude Code reads the env var directly

### Codex

- Package: `@openai/codex` (installed via `npm install -g`)
- Auth: set `OPENAI_API_KEY` in your `.env`, or run `codex --login` inside
  the box (opens Chromium via the display stack)

## Notes

- Electron renders against software Xvfb (no GPU). Fine for dev work; not
  pixel-accurate vs. a native build.
- `DEVBOX_ELECTRON_NO_SANDBOX=1` is set in `devcontainer.json` so Electron
  launches with `--no-sandbox` in the container. Your repo's Electron dev
  script should read this env var and pass `--no-sandbox` when it's set.
- For a native VNC client instead of the browser, point it at
  `<container-name>.orb.local:5900`.
- Template drift: if you want to pick up changes from a newer version of
  `@gannonh/devbox`, re-run `npx @gannonh/devbox init --force`. An `update`
  command is planned for a future release.
