# @gannonh/devbox

One command spins up an isolated Ubuntu dev container per git worktree, with a headed display viewable in your browser. Run multiple worktrees of the same repo concurrently with no port collisions.

Each box includes Node/Bun, git, `gh`, ripgrep, fd, fzf, tmux, a coding agent (Pi by default; Claude Code and Codex as one-line alternatives), and a headed desktop (Xvfb + fluxbox + x11vnc + noVNC) rendered in a browser tab. The container config uses the standard devcontainer format, so it also works in Codespaces and Cursor.

Boxes run locally by default, or in a Vercel Sandbox in the cloud. See [Providers](#providers-where-the-box-runs).

## Quickstart

```bash
npx @gannonh/devbox init      # scaffold .devbox/ + .devcontainer/ into this repo
npx @gannonh/devbox my-branch # boot a box for that branch, drop you into it
```

`init` prints the files it creates and suggested tailoring steps. Booting prints a ready banner with the display URL. On OrbStack it looks like `http://<container>.orb.local:6080/vnc.html`. Vercel boxes print an HTTPS display link instead.

To run from a checkout of this repository:

```bash
npm run build && node dist/cli.js --help
```

## What runs on your machine

Devbox builds images and runs containers and shell hooks. This is the full surface:

- **Files.** `init` writes `.devbox/` and `.devcontainer/` in your repo. Outside those and its own state under `~/.local/state` (XDG), devbox writes nothing. Delete the two directories to undo `init`.
- **Execution.** The local provider runs Docker (`docker build`, `docker exec`) driven by your devcontainer config, plus the hooks in `.devbox/provision.sh` inside the container. Both are plain shell in your repo.
- **Credentials forwarded in.** Your host `gh auth token` is copied into the box so `git push` works there. Pi's config is copied from host `~/.pi` (sessions and npm cache excluded). Project dotenv values enter only when you pass `--env PATH`; omitting it transfers no project environment.
- **Network.** Local boxes pull base images and install dependencies. Devbox makes no telemetry calls. The Vercel provider clones your GitHub origin into a Vercel Sandbox and exposes HTTPS routes; accepted app ports are public to anyone with the URL.
- **Uninstall.** `npx @gannonh/devbox <branch> --rm` removes that box's container, worktree, and branch. Remove the package with `npm un -g @gannonh/devbox` if globally installed; `npx` usage leaves nothing on disk except the state directory.

## What one command does

`npx @gannonh/devbox <branch>` fetches `origin`, creates a git worktree from `origin/<default>` (`DEVBOX_START_POINT=local` to use the local default instead), builds the image once, boots the container, and starts a shell in `/workspace` as a non-root user.

- **Per-worktree isolation.** Each worktree gets its own container and network namespace, so concurrent boxes never collide on ports.
- **Headed display.** Xvfb + fluxbox + x11vnc + noVNC run inside the box; Electron apps render there and are visible in any browser.
- **Chromium + OAuth inside the box.** `xdg-open` routes to Chromium, so OAuth consent flows complete inside the container, visible over noVNC.
- **Agent built in.** Pi is active by default. Switching agents is comment-toggling blocks in `.devbox/provision.sh`.

## Prerequisites

- **OrbStack** or any Docker runtime (OrbStack provides the `<container>.orb.local` URLs). [orbstack.dev](https://orbstack.dev)
- **`@devcontainers/cli`** — `npm i -g @devcontainers/cli`
- **`gh`** authenticated on the host — `gh auth login`
- **git** 2.45+ (for `worktree --relative-paths`)
- **Optional:** host `~/.pi` if you use the Pi agent

## Commands

```bash
npx @gannonh/devbox init                              # scaffold config into this repo
npx @gannonh/devbox <branch>                          # boot a local box (default provider)
npx @gannonh/devbox <branch> --env PATH              # inject dotenv values into this run
npx @gannonh/devbox <branch> --attach                # re-enter a running box
npx @gannonh/devbox <branch> --stop                  # stop (keeps worktree + container)
npx @gannonh/devbox <branch> --rm                    # remove container + worktree + branch
npx @gannonh/devbox <branch> --url                   # print current provider routes
npx @gannonh/devbox <branch> --open                  # open the first route in a browser
npx @gannonh/devbox --list                           # list local devbox containers
```

`--attach` reuses the environment stored with the box; passing `--env` again replaces it. `--stop` rejects `--env`, since stopping transfers nothing.

## Coding agents

`provision.sh` ships three agent blocks, Pi active by default:

| Agent | Package | Auth |
| --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent` | copied from host `~/.pi` |
| Claude Code | `@anthropic-ai/claude-code` | `ANTHROPIC_API_KEY` |
| Codex | `@openai/codex` | `OPENAI_API_KEY` or `codex --login` |

To switch, comment-toggle the blocks in `.devbox/provision.sh` and remove the `~/.pi` mount from `.devcontainer/devcontainer.json`.

## Providers: where the box runs

| Provider | Runs on | Reachable at | Source of your code |
| --- | --- | --- | --- |
| `local` (default) | your machine, via OrbStack/Docker | `<container>.orb.local:<port>` | the worktree on disk, uncommitted work included |
| `vercel` | a Vercel Sandbox in the cloud | HTTPS routes issued by Vercel | the authenticated GitHub origin — pushed commits only |

The choice is remembered per repository until you pass `--provider` again. A remembered cloud provider prints a notice before it runs.

### Vercel Sandboxes

Runs the box in Vercel's cloud; no local Docker runtime needed, and the display is reachable over HTTPS from anywhere.

```bash
npx @gannonh/devbox --provider vercel my-branch   # boot; later commands reuse it
npx @gannonh/devbox my-branch --password          # print the display access code
```

- **Remote-first source.** The Sandbox clones the GitHub origin, so dirty files and unpushed commits stay on your machine.
- **Confirmed scope on first use.** Devbox prints the Vercel team and project and requires confirmation in a TTY. Credentials resolve in order: a complete `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` triad, then `VERCEL_OIDC_TOKEN`, then device auth scoped by `.vercel/project.json`.
- **Display link pairs on click.** The printed link carries a one-use access code, exchanged for a session cookie on open. A stale or truncated link lands on the pairing form; paste the code from `--password`.
- **Terminal keys.** `Ctrl-C` reaches the remote foreground process; `Ctrl-]` detaches without stopping the Sandbox.
- **App ports.** After checkout, devbox reads `package.json` manifests as data (never executed) and offers conventional ports such as Vite's `5173`; monorepo workspace members are scanned too. Accepted ports are public and are added to the running Sandbox without recreating it. Non-interactive form:

  ```bash
  npx @gannonh/devbox --provider vercel my-branch --expose-ports 5173
  ```

  Serving on the port is your app's job. Bind externally (`npm run dev -- --host 0.0.0.0 --strictPort`) and, on Vite 5.4.12+, add `server.allowedHosts: ['.vercel.run']`.

Commands, configuration precedence, and recovery behavior are in the [provider reference](docs/reference/vercel-provider.md).

<details>
<summary>Why the runtime image is digest-pinned</summary>

A Sandbox boots from an OCI image, so devbox ships one carrying the display stack and toolchain. The rule is tags for development, digests for releases: a published package carries a digest frozen at publish time, so every Sandbox runs the exact artifact its smoke evidence proves, while a git checkout follows the `nightly` channel. Nothing in the source tree contains a digest, so an image change is one pull request. Set `DEVBOX_VERCEL_IMAGE` to a fully-qualified digest reference to run a locally built image; it is refused against a published release. Channels, rollback, and orphan cleanup are in the [image supply chain runbook](docs/runbooks/vercel-image-supply-chain.md).

</details>

## Maintainer-facing: CI and release infrastructure

<details>
<summary>Workflows, secrets, and what credentialed runs verify</summary>

Unit tests cover provider logic in isolation. Proving the Vercel provider end to end needs live infrastructure and production credentials, so that work runs in scheduled workflows rather than on every push:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **CI** | every push and pull request | lint, typecheck, build, tests — no credentials |
| **Nightly** | scheduled on `main`, or dispatched at any ref | builds the image, runs publisher and consumer smoke gates, publishes a prerelease |
| **Release** | manual, default branch | promotes a proven nightly digest to `stable` and `latest`, gated by terminal smoke, UAT, and the five-run benchmark |

Pull requests never receive cloud credentials, and no label authorizes anything. To prove a branch against real infrastructure, dispatch Nightly against that ref; add `publish` to install it with `npx @gannonh/devbox@dev-<branch>`. Credentialed runs require the repository owner and the protected `vercel-provider-smoke` environment.

Required repository secrets: `VERCEL_CONSUMER_TOKEN` / `VERCEL_CONSUMER_TEAM_ID` / `VERCEL_CONSUMER_PROJECT_ID` (consumer triad for the `devbox-uat` project, mapped into the script environment as `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`), `DEVBOX_GITHUB_FIXTURE_TOKEN`, `DEVBOX_GITHUB_FIXTURE_REPOSITORY`, `DEVBOX_GITHUB_FIXTURE_BRANCH`, `DEVBOX_GITHUB_FIXTURE_DEFAULT_BRANCH`, and `DEVBOX_GITHUB_FIXTURE_EXPECTED_FILE` / `..._EXPECTED_CONTENT`.

A run verifies clone (remote, exact revision, clean worktree, fixture content, detached `HEAD` allowed on the existing path), terminal protocol (`openInteractive` per session, Ctrl-C SIGINT delivery, production Ctrl-] escape detachment through stop/snapshot completion), image identity (manifest digest must exactly match the promoted pin; anything else fails closed), and cleanup (preflight plus per-path reconciliation until every sandbox and snapshot is absent, deleted, or provably terminal). Evidence artifacts carry non-reversible fingerprints only — never fixture values, tokens, or Vercel IDs — and upload after a final redaction step, including on failure. Ambiguous duplicates found during recovery follow the manual path in the supply chain runbook rather than `--rm`.

The design history is in the [Vercel provider convergence issue](https://github.com/gannonh/devbox/issues/7) and the [OKF docs bundle](docs/index.md).

</details>

## Status

Stable releases publish to npm (`latest`) from proven nightlies. See the release workflow above for how a version earns its tag.

## License

[MIT](LICENSE)
