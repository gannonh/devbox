# Scaffold a devbox configuration

The `init` command writes the local `.devbox/` templates and `.devcontainer/devcontainer.json`, then tells the user how to customize and boot them.

## Sub-features

- `init-create` creates five `.devbox` files and one `.devcontainer` file.
- `init-idempotent` returns success without changing matching files.
- `init-conflict` refuses to overwrite a changed file without `--force`.
- `init-force` restores the templates after a deliberate change.
- `init-interactive-skill` offers to install the bundled Agent skill only in a TTY.

## How to get to it (user POV)

- Run `npx @gannonh/devbox init` from the repository where you want the files.
- Run `npx @gannonh/devbox init --force` after reviewing a changed generated file.
- Answer `y` or `yes` at the interactive Agent skill prompt to install `.agents/skills/devbox/SKILL.md`.
- Answer `n`, `no`, or an empty line to leave the Agent skill uninstalled.

## Driving it with POSIX shell and the built Node CLI

Preconditions:

- `npm run build` has completed.
- The evidence directory is outside the scratch directory.
- The command runs from a new temporary directory, never from the source checkout.

Run the real CLI path and capture both streams.

```sh
set -euo pipefail
source_root="$PWD"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
evidence_dir="$source_root/uat-evidence/verify-devbox/$run_id/init-scaffold"
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/devbox-init-verify-XXXXXX")"
mkdir -p "$evidence_dir"
cleanup() { rm -r -- "$scratch_dir"; }
trap cleanup EXIT

if (cd "$scratch_dir" && node "$source_root/dist/cli.js" init >"$evidence_dir/create.stdout.txt" 2>"$evidence_dir/create.stderr.txt"); then
  create_exit=0
else
  create_exit=$?
fi
test "$create_exit" -eq 0
test -f "$scratch_dir/.devbox/Dockerfile"
test -f "$scratch_dir/.devbox/provision.sh"
test -f "$scratch_dir/.devbox/start-display.sh"
test -f "$scratch_dir/.devbox/post-create.sh"
test -f "$scratch_dir/.devbox/README.md"
test -f "$scratch_dir/.devcontainer/devcontainer.json"
grep -Fq '[devbox] created:' "$evidence_dir/create.stderr.txt"

if (cd "$scratch_dir" && node "$source_root/dist/cli.js" init >"$evidence_dir/idempotent.stdout.txt" 2>"$evidence_dir/idempotent.stderr.txt"); then
  idempotent_exit=0
else
  idempotent_exit=$?
fi
test "$idempotent_exit" -eq 0
grep -Fq '.devbox/ already exists and all files match' "$evidence_dir/idempotent.stderr.txt"

printf '\nverification mutation\n' >> "$scratch_dir/.devbox/README.md"
if (cd "$scratch_dir" && node "$source_root/dist/cli.js" init >"$evidence_dir/conflict.stdout.txt" 2>"$evidence_dir/conflict.stderr.txt"); then
  conflict_exit=0
else
  conflict_exit=$?
fi
test "$conflict_exit" -eq 1
grep -Fq '.devbox/ exists but some files differ' "$evidence_dir/conflict.stderr.txt"

if (cd "$scratch_dir" && node "$source_root/dist/cli.js" init --force >"$evidence_dir/force.stdout.txt" 2>"$evidence_dir/force.stderr.txt"); then
  force_exit=0
else
  force_exit=$?
fi
test "$force_exit" -eq 0
! grep -Fq 'verification mutation' "$scratch_dir/.devbox/README.md"

repo_name="$(basename "$scratch_dir")"
grep -Fq "\"$repo_name-devbox\"" "$scratch_dir/.devcontainer/devcontainer.json"
! grep -R -Fq '{{REPO_NAME}}' "$scratch_dir/.devbox" "$scratch_dir/.devcontainer"
test -x "$scratch_dir/.devbox/provision.sh"
test -x "$scratch_dir/.devbox/start-display.sh"
test -x "$scratch_dir/.devbox/post-create.sh"

for generated_path in "$scratch_dir"/.devbox/* "$scratch_dir"/.devcontainer/*; do
  test -f "$generated_path" && printf '%s\n' "$generated_path"
done | sed "s#^$scratch_dir/##" | sort > "$evidence_dir/generated-files.txt"
(cd "$scratch_dir" && shasum -a 256 .devbox/* .devcontainer/devcontainer.json) > "$evidence_dir/generated-files.sha256"
printf 'feature=init-scaffold\ncreate_exit=%s\nidempotent_exit=%s\nconflict_exit=%s\nforce_exit=%s\n' "$create_exit" "$idempotent_exit" "$conflict_exit" "$force_exit" > "$evidence_dir/result.txt"

cleanup
trap - EXIT
test ! -e "$scratch_dir"
test -s "$evidence_dir/result.txt"
```

The first run proves creation. The second run proves idempotency. The mutation and `--force` runs prove the conflict boundary and repair behavior. The file list, hashes, and executable checks prove the filesystem side effect.

To verify the Agent skill prompt, create a second empty scratch directory and start `node "$source_root/dist/cli.js" init` in a new `tmux` session. Wait for `[y/N]`, capture the pane, send `n` followed by Enter, and capture the pane again. The transcript must contain the prompt and the skipped-install message. Answer `y` only when the scratch directory is disposable, then verify `.agents/skills/devbox/SKILL.md` exists. Kill that exact `tmux` session and remove that exact scratch directory after the check.

## Gotchas

- `init` uses the current working directory. A command run from the source checkout changes the checkout.
- `init` does not require a Git repository. The branch commands do.
- The command writes its success and guidance output to stderr.
- The interactive Agent skill prompt is skipped when stdin is not a TTY.
- `--force` overwrites differences. Do not use it on a real repository until the change is understood.
- The repository name becomes part of `.devcontainer/devcontainer.json`. Check the rendered value, not the token source.
