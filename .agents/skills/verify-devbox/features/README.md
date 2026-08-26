# devbox verification map

This directory is the maintained map for verifying the user-facing `devbox` CLI. Read the baseline first, then use the feature file that matches the behavior under review.

## Baseline preconditions

- Run `npm ci` when dependencies are absent.
- Run `npm run build` to produce the CLI under `dist/`.
- Run `node dist/cli.js --version` and `node dist/cli.js --help` after the build completes.
- Run build and CLI commands sequentially. `npm run build` removes `dist/` before TypeScript emits it.
- Create evidence under `uat-evidence/verify-devbox/<run-id>/`.
- Use disposable directories and unique names for every run. Never drive an instance created by another run.
- Load dotenv files only in the child shell that invokes the CLI. Never put a credential in argv or evidence.
- Use the exact local provider branch and `DEVBOX_WORKTREES_DIR` when testing local lifecycle behavior.
- Use GitHub Actions Nightly for a branch-level Vercel proof. Pull requests do not receive cloud credentials.

## Driving conventions

- Drive the CLI through `node dist/cli.js` from the built checkout.
- Capture stdout, stderr, and the exit code for every command.
- Use stable terminal markers such as `devbox ready`, `provider set to`, and `removed devbox for` rather than terminal coordinates.
- Use `tmux` for commands that open an interactive box shell.
- Use explicit `--provider local` for local commands. A remembered Vercel provider creates billable resources.
- Re-read URLs after a Vercel port update. Route subdomains can change on update.
- Verify mutations with a second user-visible view or a read-only state check.

## Proof and skip reporting

- Capture the command and the resulting state, not just the final screen or log line.
- Keep evidence after cleanup. Scratch state is disposable; evidence is not.
- For `init`, prove generated files, permissions, token replacement, idempotency, and force repair.
- For local boxes, prove the shell marker, worktree, branch, container, URL, stop or attach behavior, and removal.
- For Vercel, use the redacted report from the owner-triggered workflow and verify no Sandbox, snapshot, session, branch, or metadata remains.
- Report a skip with the command, the unmet precondition, and the path that remains unverified.
- Do not report a local recipe as verified when Docker is unavailable.
- Do not report a Vercel recipe as verified from unit tests or a credential check.

## Features

- [Scaffold a devbox configuration](./init-scaffold.md) covers `init`, idempotency, conflict detection, force repair, and the interactive skill prompt.
- [Operate a local box](./local-box-lifecycle.md) covers local boot, attach, stop, URL, list, environment injection, and removal.
- [Select a provider and inspect the CLI](./provider-and-cli-discovery.md) covers help, version, remembered provider state, and listing.
- [Operate a Vercel Sandbox](./vercel-box-lifecycle.md) covers remote boot, terminal detach, attach, URL, password, stop, list, and removal.
- [Expose an app port](./app-route-exposure.md) covers configured and inferred ports, explicit `--expose-ports`, route labels, relay behavior, and limits.
