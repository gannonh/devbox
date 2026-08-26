# Expose an app port

The Vercel provider discovers Vite and Next app ports in the remote checkout, asks for public-route consent in a TTY, and accepts explicit ports through `--expose-ports` outside a TTY. Each approved logical port maps to a relay-backed HTTPS route.

## Sub-features

- `configured-port` retains ports from `.devcontainer/devcontainer.json`.
- `inferred-port` offers Vite and Next candidates from package manifests and dev scripts.
- `explicit-port` accepts a validated comma-separated list through `--expose-ports`.
- `route-label` prints the logical app port and current public URL through `--url`.
- `relay-path` serves a loopback-bound app through the Sandbox relay and preserves HTTP, streaming, and WebSocket behavior.
- `port-limit` rejects unsafe or excessive port sets before the provider update.

## How to get to it (user POV)

- Run `devbox --provider vercel <branch>` in a TTY and review the inferred public app routes.
- Enter to accept the candidates, `n` to reject them, or `e` to edit the inferred set.
- Run `devbox --provider vercel <branch> --expose-ports 5173,3000` to opt in without a prompt.
- Run `devbox --provider vercel <branch> --url` after the app starts to read the current route labels.
- Start the project's ordinary dev command inside the remote terminal. Devbox does not rewrite that command.

## Driving it with the existing Vercel app-route UAT

Preconditions:

- The owner-triggered Vercel UAT has the consumer Vercel triad and fixture repository secrets.
- The linked fixture exists at `/Volumes/EVO/dev/uat-runs/devbox/uat-devbox`.
- The source commit and pinned fixture commit are the revisions under test.
- Evidence is outside the fixture and contains no credential or display code.

The repository's real app-route driver is `scripts/vercel/app-port-uat.mjs`. It exercises production CLI dispatch, the candidate detector, the route update, the relay, same-Sandbox attach, metadata reconciliation, snapshot resume, selection changes, the port limit, and cleanup.

For the linked fixture, source `.env.local` in the child shell and keep `.vercel/project.json` in the fixture. The command uses the real Vercel SDK and creates disposable resources.

```sh
source_root="$PWD"
fixture_root="/Volumes/EVO/dev/uat-runs/devbox/uat-devbox"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
evidence_dir="$source_root/uat-evidence/verify-devbox/$run_id/app-route"
mkdir -p "$evidence_dir"

(set -a && . "$fixture_root/.env.local" && set +a && \
  DEVBOX_UAT_REPO_ROOT="$fixture_root" \
  DEVBOX_UAT_REPORT="$evidence_dir/app-port-uat.json" \
  DEVBOX_UAT_ONLY=monorepo \
  node "$source_root/scripts/vercel/app-port-uat.mjs")
```

The report must show a candidate for the `apps/web` Vite app, an initial `6080` display route, the selected logical app port, a route update without a new Sandbox, the fixture marker over the public route, browser HMR, same-Sandbox attach, metadata recovery, the live limit boundary, and final resource absence.

For direct CLI coverage, set a unique branch and run the user command from the linked fixture in an allocated PTY.

```sh
branch="verify-devbox-$run_id"
(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --expose-ports 5173 \
  >"$evidence_dir/explicit.stdout.txt" 2>"$evidence_dir/explicit.stderr.txt")
(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --url \
  >"$evidence_dir/url.stdout.txt" 2>"$evidence_dir/url.stderr.txt")
(cd "$fixture_root" && set -a && . "$fixture_root/.env.local" && set +a && \
  node "$source_root/dist/cli.js" --provider vercel "$branch" --rm \
  >"$evidence_dir/rm.stdout.txt" 2>"$evidence_dir/rm.stderr.txt")
```

The explicit path must mention the logical port and a public HTTPS route. The `--rm` command must remove the exact branch's resources. The UAT report must verify the side effect through the real app response and then prove that cleanup removed the route, Sandbox, snapshots, and local metadata.

## Gotchas

- Accepted app routes are public to anyone with the URL. Treat port approval as a disclosure decision.
- Outside a TTY, Vercel exposes no new app port unless `--expose-ports` is present.
- Configured ports cannot be removed by editing only the inferred candidate answer.
- `--expose-ports` is valid only with a boot or `--attach`. It rejects duplicates, `5900`, the internal noVNC port, and invalid decimal values.
- The provider caps the full set at 14 ports. `6080` consumes one slot, so at most 13 app ports can be exposed.
- Route subdomains can change after an update. Use fresh `--url` output.
- The public route points to the relay, not directly to the app listener. The relay presents the app with `Host: localhost:<port>`.
- A route can answer `502` before the app starts. Wait for the app marker, not only for route creation.
- Do not trust a dry-run label. Inspect the route, network, files, and Git refs that the run actually changed.
