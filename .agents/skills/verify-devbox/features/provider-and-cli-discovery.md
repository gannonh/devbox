# Select a provider and inspect the CLI

The CLI exposes version and help output, remembers a provider per repository, and lists boxes for the selected provider.

## Sub-features

- `version` prints the installed package version.
- `help` prints global and command-specific usage.
- `provider-set` stores `local` or `vercel` for the current repository.
- `provider-switch` changes the remembered provider when the user passes a new explicit provider.
- `provider-list` lists boxes for the selected provider.

## How to get to it (user POV)

- Run `devbox --version` or `devbox --help`.
- Run `devbox --provider local` or `devbox --provider vercel` to set the repository choice.
- Run `devbox --list` or `devbox --provider local --list` to inspect local boxes.
- Run `devbox --provider vercel --list` to inspect Vercel boxes for the current repository.

## Driving it with POSIX shell and the built Node CLI

Preconditions:

- `npm run build` has completed.
- `source_root` is the checkout under review.
- `XDG_STATE_HOME` points to a new run-specific directory so the source checkout's provider preference is untouched.

```sh
set -euo pipefail
source_root="$PWD"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
evidence_dir="$source_root/uat-evidence/verify-devbox/$run_id/provider-and-cli"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/devbox-state-verify-XXXXXX")"
mkdir -p "$evidence_dir"
cleanup() { rm -r -- "$state_dir"; }
trap cleanup EXIT
export XDG_STATE_HOME="$state_dir"

node "$source_root/dist/cli.js" --version >"$evidence_dir/version.stdout.txt" 2>"$evidence_dir/version.stderr.txt"
node "$source_root/dist/cli.js" --help >"$evidence_dir/help.stdout.txt" 2>"$evidence_dir/help.stderr.txt"
grep -Fq 'devbox init [--force]' "$evidence_dir/help.stdout.txt"
grep -Fq -- '--provider local|vercel' "$evidence_dir/help.stdout.txt"
grep -Fq 'devbox [--provider local|vercel] --list' "$evidence_dir/help.stdout.txt"

node "$source_root/dist/cli.js" --provider vercel >"$evidence_dir/set-vercel.stdout.txt" 2>"$evidence_dir/set-vercel.stderr.txt"
grep -Fq 'provider set to vercel for this repository' "$evidence_dir/set-vercel.stdout.txt"
node "$source_root/dist/cli.js" --provider local >"$evidence_dir/set-local.stdout.txt" 2>"$evidence_dir/set-local.stderr.txt"
grep -Fq 'provider set to local for this repository' "$evidence_dir/set-local.stdout.txt"
grep -R -Fq '{"provider":"local"}' "$state_dir/devbox/repos"

if docker info >/dev/null 2>&1; then
  node "$source_root/dist/cli.js" --provider local --list >"$evidence_dir/local-list.stdout.txt" 2>"$evidence_dir/local-list.stderr.txt"
  grep -Fq 'devbox containers:' "$evidence_dir/local-list.stderr.txt"
else
  printf 'skipped=local-list\nreason=docker daemon unavailable\n' > "$evidence_dir/local-list.skipped.txt"
fi

cleanup
trap - EXIT
test ! -e "$state_dir"
test -s "$evidence_dir/version.stdout.txt"
```

The state file proves the explicit provider choice persisted. The second explicit `--provider local` also proves that a remembered cloud provider can be changed before an unqualified lifecycle command. The list path is conditional on Docker. Keep a skip record when the daemon is unavailable.

## Gotchas

- Provider state is keyed by a hash of the repository root under `$XDG_STATE_HOME/devbox/repos`.
- The provider state file is mode `0600`. Do not copy it into evidence when a provider-specific version may add sensitive fields.
- A remembered Vercel provider prints a notice before an operation. Pass `--provider local` explicitly for local verification.
- `--list` is a provider operation. Local listing needs a reachable Docker daemon. Vercel listing needs cloud credentials.
- `--provider` cannot be combined with `init`.
