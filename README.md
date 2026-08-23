# @gannonh/devbox

`@gannonh/devbox` creates an isolated Ubuntu dev container for each Git worktree. Every container has its own network namespace and a desktop you can open in a browser.

The default image includes Node, Bun, git, `gh`, ripgrep, fd, fzf, tmux, Chromium, and Pi. You can switch the coding agent to Claude Code or Codex. The generated configuration follows the devcontainer specification and also works in Codespaces and Cursor.

Devbox runs containers on your machine by default. It can also run them in a Vercel Sandbox. See [Providers](#providers).

## Quick start

```bash
npx @gannonh/devbox init      # create .devbox/ and .devcontainer/
npx @gannonh/devbox my-branch # create the worktree and open a shell in its container
```

`init` lists each file it creates. Booting a local box prints its display URL. With OrbStack, the URL has the form `http://<container>.orb.local:6080/vnc.html`. Vercel boxes print an HTTPS URL.

To run devbox from this repository:

```bash
npm run build
node dist/cli.js --help
```

## Requirements

- Node.js 22 or newer
- OrbStack or another Docker runtime for local boxes. OrbStack provides the `<container>.orb.local` URLs.
- `@devcontainers/cli`, installed with `npm install -g @devcontainers/cli`
- Git 2.45 or newer for `worktree --relative-paths`
- An authenticated GitHub CLI, set up with `gh auth login`
- Host configuration in `~/.pi` if you use Pi

## What devbox changes

- `init` writes `.devbox/` and `.devcontainer/` in the current repository. Delete both directories to undo it.
- The local provider runs `docker build` and `docker exec` from the devcontainer configuration. It runs `.devbox/provision.sh` inside the container.
- Devbox copies the token from `gh auth token` into the box so Git can push. It also copies Pi configuration from `~/.pi`, excluding sessions and the npm cache.
- Devbox loads project environment variables only when you pass `--env PATH`. It does not copy the dotenv file itself.
- Local boxes pull base images and install dependencies. Devbox sends no telemetry.
- The Vercel provider clones the GitHub origin into a Vercel Sandbox and creates HTTPS routes. Anyone with an app route URL can reach that port.
- Devbox stores provider preferences and metadata under `$XDG_STATE_HOME/devbox`, or `~/.local/state/devbox` when `XDG_STATE_HOME` is unset.

Run `npx @gannonh/devbox <branch> --rm` to remove a box, its worktree, and its branch. Uncommitted work in that worktree may be lost. If you installed the package globally, remove it with `npm uninstall -g @gannonh/devbox`. After removing all boxes, delete the state directory above to clear stored preferences and metadata.

## Commands

```bash
npx @gannonh/devbox init                              # create config in this repo
npx @gannonh/devbox <branch>                          # boot a local box
npx @gannonh/devbox <branch> --env PATH               # load dotenv values for this run
npx @gannonh/devbox <branch> --attach                 # enter a running box
npx @gannonh/devbox <branch> --stop                   # stop the box but keep its resources
npx @gannonh/devbox <branch> --rm                     # remove the box, worktree, and branch
npx @gannonh/devbox <branch> --url                    # print provider routes
npx @gannonh/devbox <branch> --open                   # open the first route
npx @gannonh/devbox --list                            # list local boxes
```

`--attach` reuses the environment stored with the box. Passing `--env` again replaces it. `--stop` rejects `--env` because stopping a box transfers no environment values.

## How it works

`npx @gannonh/devbox <branch>` fetches `origin`, creates a worktree from `origin/<default>`, builds the image if needed, starts the container, and opens a shell at `/workspace` as a non-root user. Set `DEVBOX_START_POINT=local` to create the worktree from the local default branch instead.

Each worktree gets a separate container and network namespace, so two worktrees can bind the same port. Xvfb, fluxbox, x11vnc, and noVNC provide the browser desktop. `xdg-open` uses Chromium inside the box, which keeps OAuth consent flows inside the container.

## Coding agents

`.devbox/provision.sh` contains setup blocks for three agents. Pi is enabled by default.

| Agent | Package | Authentication |
| --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent` | copied from host `~/.pi` |
| Claude Code | `@anthropic-ai/claude-code` | `ANTHROPIC_API_KEY` |
| Codex | `@openai/codex` | `OPENAI_API_KEY` or `codex --login` |

To switch agents, enable the matching block in `.devbox/provision.sh`. If you disable Pi, also remove the `~/.pi` mount from `.devcontainer/devcontainer.json`.

## Providers

| Provider | Runs on | Address | Source code |
| --- | --- | --- | --- |
| `local` | OrbStack or Docker on your machine | `<container>.orb.local:<port>` with OrbStack | local worktree, including uncommitted files |
| `vercel` | Vercel Sandbox | Vercel HTTPS routes | authenticated GitHub origin, using pushed commits only |

Devbox remembers the provider for each repository until you pass `--provider` again. It prints a notice before using a remembered Vercel provider.

### Vercel Sandbox

The Vercel provider runs without a local Docker runtime and makes the display available over HTTPS.

```bash
npx @gannonh/devbox --provider vercel my-branch
npx @gannonh/devbox my-branch --password
```

The Sandbox clones the GitHub origin. Dirty files and unpushed commits remain on your machine.

On first use, devbox prints the Vercel team and project, then asks for confirmation in a TTY. It checks credentials in this order:

1. `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`
2. `VERCEL_OIDC_TOKEN`
3. Vercel device authentication scoped by `.vercel/project.json`

The display URL contains a one-use access code. Opening the complete URL exchanges the code for a session cookie. If the URL is stale or incomplete, run `--password` and enter the printed code in the pairing form.

In the remote terminal, `Ctrl-C` reaches the foreground process. `Ctrl-]` disconnects without stopping the Sandbox.

After checkout, devbox reads `package.json` files without executing them and suggests common application ports such as Vite's `5173`. It also scans npm workspace members. Approved ports become public without recreating the Sandbox. To skip the prompt, pass the ports explicitly:

```bash
npx @gannonh/devbox --provider vercel my-branch --expose-ports 5173
```

On the boot that creates the sandbox, `--timeout <minutes>` sets the Sandbox timeout (1-1440 minutes; default 60) and `--vcpus <n>` sets the Sandbox vCPUs (1 or an even number up to 32; 2048 MB of memory per vCPU; Vercel defaults to 2). Both are stored per branch like the image, so neither resizes an existing box: changing one later conflicts, and `--rm` plus a fresh boot is the way to change them.

```bash
npx @gannonh/devbox --provider vercel my-branch --timeout 90 --vcpus 4
```

Your application must listen on the exposed port. For Vite, run `npm run dev -- --host 0.0.0.0 --strictPort`. On Vite 5.4.12 or newer, add `server.allowedHosts: ['.vercel.run']`.

See the [Vercel provider reference](docs/reference/vercel-provider.md) for command details, configuration order, and recovery behavior.

<details>
<summary>Runtime image pinning</summary>

Vercel Sandboxes boot from an OCI image. Published packages contain the digest of the image that passed their smoke tests. Repository checkouts use the `nightly` channel instead. The source tree contains no digest because `scripts/vercel/emit-image-pin.mjs` writes it into `dist/` during publication.

Set `DEVBOX_VERCEL_IMAGE` to a fully qualified digest to test a locally built image. Published releases reject this override. See the [image supply chain runbook](docs/runbooks/vercel-image-supply-chain.md) for channels, rollback, and cleanup.

</details>

## Maintainer CI and releases

<details>
<summary>Workflows, secrets, and credentialed checks</summary>

Unit tests cover provider logic without live credentials. Vercel checks run in scheduled or manually dispatched workflows.

| Workflow | Trigger | Checks |
| --- | --- | --- |
| CI | every push and pull request | lint, types, build, and tests without credentials |
| Nightly | scheduled on `main`, or manually dispatched at any ref | image build, publisher and consumer smoke tests, and prerelease publication |
| Release | manual run from the default branch | stable tag promotion after terminal smoke tests, UAT, and the five-run benchmark |

Pull requests receive no cloud credentials. Labels do not authorize credentialed runs. To test a branch against Vercel, dispatch Nightly for that ref. Pass `publish` to install the result as `npx @gannonh/devbox@dev-<branch>`. Credentialed runs require the repository owner and the protected `vercel-provider-smoke` environment.

Repository secrets include the Vercel consumer credential triad, the GitHub fixture token and repository details, and the expected fixture file and content. The workflow maps the Vercel values to `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` for the smoke process.

The smoke run checks the exact Git revision, terminal signal and detach behavior, image identity, and resource cleanup. Evidence contains one-way fingerprints rather than fixture values, tokens, or Vercel IDs. A final redaction step runs before upload, including after failures. If cleanup finds ambiguous duplicate resources, follow the manual procedure in the supply chain runbook instead of running `--rm`.

See the [Vercel provider convergence issue](https://github.com/gannonh/devbox/issues/7) and the [documentation index](docs/index.md) for design history and maintainer procedures.

</details>

## Status

Stable releases publish to the npm `latest` tag after their nightly build passes the release checks above.

## License

[MIT](LICENSE)
