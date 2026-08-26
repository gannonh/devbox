# Operate a Vercel Sandbox

The Vercel provider clones the authenticated GitHub origin into a Sandbox, starts the display and terminal there, and publishes HTTPS routes for approved ports. It does not copy local dirty files or unpushed commits.

## Sub-features

- `vercel-up` creates a Sandbox for a branch and opens its remote terminal.
- `vercel-detach` sends `Ctrl-]` to leave the terminal without stopping the Sandbox.
- `vercel-attach` reconnects to the existing Sandbox and re-applies confirmed routes.
- `vercel-url` prints current noVNC and app routes.
- `vercel-password` prints the display access code when the pairing form needs it.
- `vercel-stop` stops the Sandbox while retaining resumable state.
- `vercel-list` lists the current repository's Vercel Sandboxes.
- `vercel-rm` removes the Sandbox, snapshots, sessions, branch, and residual metadata after verification.

## How to get to it (user POV)

- Run `devbox --provider vercel <branch>` to create a remote box.
- Run `devbox --provider vercel <branch> --attach` to reconnect.
- Run `devbox --provider vercel <branch> --url` to print routes.
- Run `devbox --provider vercel <branch> --password` to print the display credentials.
- Run `devbox --provider vercel --list` to list remote boxes.
- Run `devbox --provider vercel <branch> --stop` to stop the Sandbox.
- Run `devbox --provider vercel <branch> --rm` to remove the Sandbox and local record.

## Driving it with POSIX shell, tmux, and GitHub Actions

Preconditions:

- Push the exact source commit to the branch under test. Vercel checks the authenticated GitHub origin, not local dirty files.
- Use an owner-triggered Nightly run for a branch-level cloud proof. Pull requests do not receive cloud credentials.
- Confirm the target Vercel team and project before creating a Sandbox. A remembered Vercel provider is visible, but it still creates billable resources.
- Load credentials in a child shell from the linked fixture when local UAT is authorized. Never pass `--token` or a credential in argv.

Start the canonical branch proof from the repository root.

```sh
branch="$(git branch --show-current)"
gh workflow run nightly.yml --ref "$branch"
gh run watch
```

The Nightly workflow builds the image candidate and runs independent publisher and consumer Sandbox smoke gates. Add `-f publish=true` only when the run must also publish the prerelease package.

For an authorized direct CLI run against the linked fixture, use the disposable project at `/Volumes/EVO/dev/uat-runs/devbox/uat-devbox`. Keep its `.vercel/project.json` local and source `.env.local` only in the child shell.

```sh
source_root="$PWD"
fixture_root="/Volumes/EVO/dev/uat-runs/devbox/uat-devbox"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
evidence_dir="$source_root/uat-evidence/verify-devbox/$run_id/vercel-box"
mkdir -p "$evidence_dir"
branch="verify-devbox-$run_id"

(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --expose-ports 5173 \
  >"$evidence_dir/up.stdout.txt" 2>"$evidence_dir/up.stderr.txt")
```

Run the interactive command in a PTY. Wait for `devbox ready`, send a unique shell marker, and send `Ctrl-]` to detach. Capture the terminal transcript. Then run these commands from the same child shell, always with the exact branch and provider.

```sh
(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --url \
  >"$evidence_dir/url.stdout.txt" 2>"$evidence_dir/url.stderr.txt")

(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel --list \
  >"$evidence_dir/list.stdout.txt" 2>"$evidence_dir/list.stderr.txt")

(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --password \
  2>"$evidence_dir/password.stderr.txt" | sed -E 's/^(password:).*/\1 [redacted]/' \
  >"$evidence_dir/password.stdout.redacted.txt")

(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --stop \
  >"$evidence_dir/stop.stdout.txt" 2>"$evidence_dir/stop.stderr.txt")

(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --attach \
  >"$evidence_dir/attach.stdout.txt" 2>"$evidence_dir/attach.stderr.txt")

(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --rm \
  >"$evidence_dir/rm.stdout.txt" 2>"$evidence_dir/rm.stderr.txt")
```

The workflow path is the required proof for a branch. It should leave a redacted report showing the source revision, terminal behavior, display pairing, route behavior, and cleanup. The direct recipe is for authorized local UAT only. Verify that `--rm` removed the exact Sandbox and that the report contains no Sandbox, snapshot, session, branch, or metadata residual.

If a Vercel UAT run fails at its configuration gate, inspect `gh secret list` for names only and inspect the run's failure reason. Report missing credentials only after the dispatched workflow reaches that gate. A green credential-free CI run does not prove the cloud path.

## Gotchas

- Vercel uses the pushed GitHub revision. Local dirty files and unpushed commits are absent from the Sandbox.
- Vercel scope confirmation is a user-facing safety boundary. Do not accept a different team or project to make a run pass.
- A Vercel Sandbox is billable cloud state. Use a unique branch and clean it up with `--rm`.
- `Ctrl-C` reaches the remote foreground process. `Ctrl-]` detaches the terminal without stopping the Sandbox.
- `--password` contains a secret. Store only the redacted output.
- Vercel setup runs in the background. Inspect `/vercel/.devbox/runtime/setup.status` and `setup.log` inside the remote terminal.
- Do not use a broad `--rm` command when cleanup is ambiguous. Follow the runbook's exact identity procedure.
