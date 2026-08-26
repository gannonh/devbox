# Operate a local box

The local provider creates a Git worktree and a Docker-backed dev container for a branch, then exposes a shell and a noVNC URL. The same branch can be attached, stopped, resumed, listed, and removed.

## Sub-features

- `local-up` creates or re-enters a local box and opens a shell at `/workspace` as `node`.
- `local-attach` re-enters a running box or starts a stopped box before attaching.
- `local-stop` stops the container while retaining the worktree and branch.
- `local-url` prints the running box's noVNC URL and can open it.
- `local-list` lists the repository's containers and their states.
- `local-env` injects dotenv values without copying the dotenv file into the worktree.
- `local-rm` removes the exact container, worktree, and branch.

## How to get to it (user POV)

- Run `devbox <branch>` to create or re-enter a local box.
- Run `devbox <branch> --attach` to re-enter a running or stopped box.
- Run `devbox <branch> --url` or `devbox <branch> --url --open` to view the display.
- Run `devbox --list` to inspect local boxes.
- Run `devbox <branch> --stop` to stop the box without removing its worktree.
- Run `devbox <branch> --rm` to remove the box, worktree, and branch.
- Add `--env` followed by a dotenv file path to a boot or attach command to inject runtime values.

## Driving it with POSIX shell, tmux, and the built Node CLI

Preconditions:

- The source repository has `.devcontainer/devcontainer.json`. Run `node dist/cli.js init` in that repository first if it does not.
- `docker info` succeeds.
- `devcontainer --version` succeeds.
- The Git version supports `git worktree --relative-paths`.
- The branch and worktree names are unique to this run.

Use a run-specific worktree directory and branch. The commands below use `tmux` because the provider opens an interactive shell.

```sh
set -euo pipefail
source_root="$PWD"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
branch="verify-devbox-$run_id"
worktrees_dir="$(mktemp -d "${TMPDIR:-/tmp}/devbox-worktrees-verify-XXXXXX")"
evidence_dir="$source_root/uat-evidence/verify-devbox/$run_id/local-box"
session="devbox-verify-$run_id"
mkdir -p "$evidence_dir"
export DEVBOX_WORKTREES_DIR="$worktrees_dir"

wait_for_marker() {
  marker="$1"
  for attempt in $(seq 1 180); do
    tmux has-session -t "$session" 2>/dev/null || return 1
    if tmux capture-pane -pt "$session" 2>/dev/null | grep -Fq "$marker"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  tmux kill-session -t "$session" 2>/dev/null || true
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    node "$source_root/dist/cli.js" --provider local "$branch" --rm >"$evidence_dir/cleanup.stdout.txt" 2>"$evidence_dir/cleanup.stderr.txt" || true
  fi
  rm -r -- "$worktrees_dir"
}
trap cleanup EXIT

tmux new-session -d -s "$session" env DEVBOX_WORKTREES_DIR="$worktrees_dir" node "$source_root/dist/cli.js" --provider local "$branch"
wait_for_marker 'devbox ready'
tmux capture-pane -pt "$session" > "$evidence_dir/up.terminal.txt"
tmux send-keys -t "$session" 'printf "DEVBOX_VERIFY_LOCAL_SHELL\\n"; pwd; id -un' C-m
wait_for_marker 'DEVBOX_VERIFY_LOCAL_SHELL'
tmux capture-pane -pt "$session" > "$evidence_dir/up-shell.terminal.txt"
grep -Fq '/workspace' "$evidence_dir/up-shell.terminal.txt"
grep -Fq 'node' "$evidence_dir/up-shell.terminal.txt"
tmux send-keys -t "$session" 'exit' C-m
while tmux has-session -t "$session" 2>/dev/null; do sleep 1; done

node "$source_root/dist/cli.js" --provider local "$branch" --url >"$evidence_dir/url.stdout.txt" 2>"$evidence_dir/url.stderr.txt"
grep -E '^http://[^ ]+:6080/vnc\.html$' "$evidence_dir/url.stdout.txt"
node "$source_root/dist/cli.js" --provider local --list >"$evidence_dir/list.stdout.txt" 2>"$evidence_dir/list.stderr.txt"
grep -Fq "$branch" "$evidence_dir/list.stderr.txt"

node "$source_root/dist/cli.js" --provider local "$branch" --stop >"$evidence_dir/stop.stdout.txt" 2>"$evidence_dir/stop.stderr.txt"
grep -Fq 'stopped' "$evidence_dir/stop.stderr.txt"
tmux new-session -d -s "$session" env DEVBOX_WORKTREES_DIR="$worktrees_dir" node "$source_root/dist/cli.js" --provider local "$branch" --attach
wait_for_marker 'starting stopped box'
tmux send-keys -t "$session" 'printf "DEVBOX_VERIFY_LOCAL_ATTACH\\n"' C-m
wait_for_marker 'DEVBOX_VERIFY_LOCAL_ATTACH'
tmux capture-pane -pt "$session" > "$evidence_dir/attach.terminal.txt"
tmux send-keys -t "$session" 'exit' C-m
while tmux has-session -t "$session" 2>/dev/null; do sleep 1; done

node "$source_root/dist/cli.js" --provider local "$branch" --stop >"$evidence_dir/stop-after-attach.stdout.txt" 2>"$evidence_dir/stop-after-attach.stderr.txt"
node "$source_root/dist/cli.js" --provider local "$branch" --rm >"$evidence_dir/rm.stdout.txt" 2>"$evidence_dir/rm.stderr.txt"
grep -Fq "removed devbox for $branch" "$evidence_dir/rm.stderr.txt"
! git show-ref --verify --quiet "refs/heads/$branch"
worktree_path="$worktrees_dir/$(basename "$source_root")-$branch"
! test -e "$worktree_path"
remaining_containers="$(docker ps -a --filter "label=devbox.repo=$(basename "$source_root")" --filter "label=devbox.branch=$branch" --format '{{.ID}}')"
test -z "$remaining_containers"

cleanup
trap - EXIT
test ! -e "$worktrees_dir"
test -s "$evidence_dir/rm.stderr.txt"
```

The terminal marker proves the real shell path. The URL and list commands prove visible state. Stop, attach, and remove prove the lifecycle transitions. The final Git and Docker checks prove the side effects are gone.

For environment injection, create a disposable dotenv file under `worktrees_dir` with a non-secret marker, then run `node "$source_root/dist/cli.js" --provider local "$branch" --env "$worktrees_dir/verify.env"` during boot or attach. Print the marker from the box shell, then remove the dotenv file with the scratch directory. Do not use a real credential as the marker.

## Gotchas

- The local provider needs both Docker and `devcontainer`. A Docker binary without a running daemon is not enough.
- Local branch boot uses a Git worktree. A failed boot can leave a branch or worktree that needs exact cleanup.
- `--rm` can lose uncommitted work in the generated worktree. Use a disposable branch in verification.
- `--url` requires a running box. A stopped box must be attached or booted first.
- The noVNC URL is local-provider-specific and uses the container name with port `6080`.
- Do not run broad `docker rm`, `docker kill`, or `git worktree remove` cleanup commands.
