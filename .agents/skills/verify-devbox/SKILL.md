---
name: verify-devbox
description: Verify @gannonh/devbox through its terminal CLI, disposable init fixtures, local container lifecycle, and GitHub Actions Vercel path. Use this skill when changing, reviewing, or debugging devbox commands, provider selection, worktree lifecycle, app-port exposure, or Vercel Sandbox behavior.
---

# Verify devbox

Use this skill to drive `@gannonh/devbox` as a user does. The primary surface is the `devbox` terminal CLI. The repository also contains a bundled `skills/devbox/SKILL.md` for operating a box, but that file is not a substitute for this verification recipe.

The safe proof path is `devbox init` in a disposable directory. Local container checks need Docker and `devcontainer`. Vercel checks create cloud resources and use the repository's owner-triggered GitHub Actions workflow.

## Launch

This is a short-lived CLI. Build the executable once before driving it.

```sh
npm ci
npm run build
```

Run the CLI checks only after `npm run build` finishes. The build removes and recreates `dist/`, so a concurrent CLI command can observe a partial output tree.

```sh
node dist/cli.js --version
node dist/cli.js --help
```

The version command must print the version from `package.json`. The help command must exit with status `0` and print the `devbox init`, provider, branch action, and `--list` commands.

There is no server to keep alive. Each local or Vercel box drive starts its own instance. Use a unique branch name, state directory, worktree directory, and PTY session. Never attach to a box that this verification run did not create.

## Doctor

Run this read-only check from the repository root before driving a feature.

```sh
set -euo pipefail
source_root="$PWD"
expected_version="$(node -p "require('./package.json').version")"
test -f "$source_root/dist/cli.js"
actual_version="$(node "$source_root/dist/cli.js" --version)"
test "$actual_version" = "$expected_version"
node "$source_root/dist/cli.js" --help >/dev/null
git -C "$source_root" remote get-url origin >/dev/null
printf 'devbox doctor: CLI %s is ready\n' "$actual_version"

if docker info >/dev/null 2>&1 && devcontainer --version >/dev/null 2>&1; then
  printf 'local runtime: available\n'
else
  printf 'local runtime: unavailable; skip local-box recipes\n'
fi
```

The build and CLI checks decide whether the instance is worth driving. The local runtime line is a capability result. Treat a failed `docker info` check as a skip for local lifecycle work, not as proof that the CLI is broken. Vercel credentials are not checked through a bare `process.env` probe. Use the Nightly workflow for the cloud path.

## Drive

Read [the verification map](./features/README.md), then choose the feature file that matches the change. Start each recipe from its listed preconditions.

Use `node dist/cli.js` while verifying this checkout. Use `npx @gannonh/devbox` only when the feature specifically tests the published consumer package. Capture both stdout and stderr because lifecycle logs and `init` output use stderr, while pipe-friendly URLs and version output use stdout.

Use an allocated PTY for `devbox <branch>` and `--attach`. `tmux` gives the CLI a real terminal and lets the recipe send a marker command, capture the terminal, and detach. The local provider exits its shell when the PTY sends `exit`. The Vercel terminal uses `Ctrl-]` to detach without stopping the Sandbox.

The default end-to-end proof is the `init-scaffold` recipe. It exercises creation, idempotency, conflict detection, force repair, file permissions, and token replacement. It does not touch Docker, Git branches, Vercel, credentials, or the source checkout.

## Evidence

Store evidence under `uat-evidence/verify-devbox/<run-id>/`. The repository ignores `uat-evidence/`, and cleanup must leave this directory in place.

Every proof records the user command and the resulting state. A CLI proof includes stdout, stderr, and the exit code. An `init` proof includes the generated file list, hashes, executable bits, and the second-run result. A local-box proof includes the terminal marker, worktree path, exact branch, container state, URL output, and post-cleanup absence. A Vercel proof uses the redacted workflow report and confirms Sandbox, snapshot, session, branch, and metadata cleanup.

Exercise the real user path. Do not call provider functions directly, alter internal state files, or use test-only endpoints. Check side effects next to visible output. Use mocks only at a production boundary that already isolates an external service.

Never put a token, `.env` value, display access code, credential-bearing URL, or raw `docker inspect` output in evidence. Redact `--password` output before writing it. The existing Vercel workflows run `scripts/vercel/redact-artifacts.mjs` before upload. If a dry-run or test mode is used, inspect files, network requests, and Git refs to confirm what it skipped.

If a precondition fails, record the attempted command and the unmet precondition in the evidence directory. Do not call a skipped path verified through another provider or entry point.

## Cleanup

The `init-scaffold` recipe removes only the disposable directory it created. It keeps the evidence directory and verifies that the scratch directory is gone after cleanup.

For a local box, send `--rm` to the exact branch with `--provider local`. Then verify that the exact worktree, branch, and container label are absent. Remove the run-specific worktree and state directories only after the provider cleanup succeeds. Never kill a process by name and never run a broad Docker cleanup.

For a Vercel box, send `--rm` to the exact branch and scope, or use the workflow's cleanup. If cleanup fails, inspect the redacted report and list only resources with the run's exact identity. Keep retry metadata until the Sandbox and snapshots are verified absent. Follow [the Vercel provider runbook](../../../docs/runbooks/vercel-provider-convergence.md) for partial cleanup.

After every failed attempt, run the cleanup for the resources that attempt created. Confirm that the evidence directory still exists after teardown.

## Helpers

This skill ships no helper script. The built CLI, POSIX shell, `tmux`, and the existing Vercel smoke scripts are the harness. The feature files contain the complete commands and cleanup boundaries.
