# @gannonh/devbox

One command spins up an isolated Ubuntu dev container per git worktree, with a headed display viewable in your browser. Run multiple worktrees of the same repo concurrently with no port collisions.

Each box is a full developer environment: Node/Bun, git, gh, ripgrep, fd, fzf, tmux, a coding agent (Pi by default; Claude Code and Codex as one-line alternatives), and a headed display (Electron apps via noVNC in your browser).

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

Open the headed display in your browser (the `init` output and the ready banner show the URL, of the form `http://<container>.orb.local:6080/vnc.html`).

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
npx @gannonh/devbox <branch> --password              # retrieve credentials when supported
npx @gannonh/devbox --list                           # list local devbox containers
npx @gannonh/devbox --provider local --list          # filter list by provider

# Vercel is core support and uses only the authenticated GitHub origin.
# Dirty files and unpushed commits are not copied. First use displays the
# Vercel team/project and requires explicit confirmation in a TTY. Without a
# complete VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID triad, device auth
# prints the verification URL and user code (and opens it when requested).
npx @gannonh/devbox --provider vercel <branch>

# In a Vercel terminal, Ctrl-C reaches the remote process and Ctrl-] detaches
# without stopping the sandbox. Core URL output lists current routes; noVNC
# and password generation/parity are not included in this phase.
# `--password` remains explicitly unsupported by the Vercel core provider.
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

## Vercel Sandbox image

The digest-pinned Vercel Sandbox image, publisher/consumer smoke workflow,
reviewed promotion process, rollback, and orphan cleanup are documented in the
[`Vercel image supply chain runbook`](docs/runbooks/vercel-image-supply-chain.md).
The live image workflow is secret-gated and never auto-promotes upstream drift.

## Real Vercel provider smoke

The secret-gated provider terminal smoke runs only from a trusted source:
manually via **Actions → Vercel provider terminal smoke → Run workflow** on
the default branch (choose `both`, `existing`, or `missing`), or on a pull
request through the caller's exact-SHA `psmoke:` label gate, which requires
the repository owner to apply the label. The workflow itself has no
pull-request trigger, rejects non-default-branch or fork dispatches, and
requires approval from the protected `vercel-provider-smoke` GitHub
environment; the caller's actor==owner condition means a user-owned
repository can only self-authorize, and a single-owner environment review is
effectively self-review (the event guard remains the boundary).

Configure these repository secrets exactly:

- `VERCEL_CONSUMER_TOKEN`, `VERCEL_CONSUMER_TEAM_ID`, `VERCEL_CONSUMER_PROJECT_ID`
  — the verified Issue #4 consumer credential triad for the `devbox-uat`
  Sandbox project (the same secrets the image supply chain consumes). The
  smoke workflow maps these values into the script environment under the exact
  generic `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` names the smoke
  script requires; nothing is inherited or re-exported. Generic
  `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` secrets are not used.
- `GITHUB_FIXTURE_TOKEN` — a read-only token that can clone the private fixture.
- `GITHUB_FIXTURE_REPOSITORY` — exact `owner/repository`.
- `GITHUB_FIXTURE_BRANCH` — the branch expected to exist for the `existing` path.
- `GITHUB_FIXTURE_DEFAULT_BRANCH` — the GitHub API default branch expectation.
- `GITHUB_FIXTURE_EXPECTED_FILE` and `GITHUB_FIXTURE_EXPECTED_CONTENT` — the
  file/content assertion shared by the clone paths.

The smoke validates the private repository and default/branch expectations,
then uses the pinned `@vercel/sandbox@3.0.0` client and terminal adapter (not a
CLI shell-out). Its Git-source examples prove the repository is seeded under a
repository-name subdirectory, and the SDK session declaration documents
`/vercel/sandbox` as the default cwd. The production client uses the object
command overload with an explicit cwd, so the existing path clones the
requested branch and the missing path clones the default, creates a run-unique
branch locally, and runs every Git assertion and terminal session in
`/vercel/sandbox/<normalized-repository>`, including resume/attach. It asserts
the remote, `HEAD`, branch, clean worktree, and fixture content, exercises
`openInteractive` once per adapter session, Ctrl-C, stop/snapshot completion,
and every created VM session. `finally` cleanup stops/removes the owned
Sandbox, paginates snapshot cleanup, re-lists until every item is absent or
`deleted`, and fails on any residual or unproven running-session state. Evidence
stores path labels and non-reversible fingerprints rather than fixture
repository/branch/file/content or Vercel team/project IDs; the workflow
redactor marks the final artifact redacted.

Artifacts are uploaded after a final redaction step, even for a normal failed
smoke. A redaction failure withholds the directory rather than risk a secret
leak. Tokens are passed through environment/headers and in-memory SDK source
credentials only; they are never command arguments, report fields, or files.
If recovery finds an ambiguous duplicate, do not blindly run `--rm`: resolve it
in the Vercel console or manually identify the exact owned resource first.

The checked-in `VERCEL_IMAGE_PIN` now references the reviewed public image and
its independent Issue #4 publisher/consumer evidence. A local provider-smoke
invocation therefore reaches credential validation and fails only when the
required configuration is absent; that is not evidence of a provider
execution. Real provider smoke still awaits a trusted default-branch
credentialed workflow dispatch. First-use device auth remains under the
repository scope lock, so concurrent first-use commands serialize confirmation
and credential persistence; later branch operations release the lock before the
terminal.

## Design spec

The package design is documented in [`docs/specs/2026-06-28-devbox-npm-package-design.md`](docs/specs/2026-06-28-devbox-npm-package-design.md).

## Status

Pre-release. The tooling is proven in production use; the standalone npm package is under active development per the design spec.

## License

[MIT](LICENSE)
