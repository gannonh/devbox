#!/usr/bin/env bash
# Worktree setup — run from the worktree root after `git worktree add`.
#
#   git worktree add ../devbox-feature main
#   cd ../devbox-feature
#   npm run worktree:setup
#
# Installs dependencies and builds the package. It never copies or links
# environment files; pass DEVBOX_ENV explicitly when a command needs one.
# Idempotent: safe to re-run.

set -euo pipefail

# Resolve the worktree root from the script location so it works regardless of
# the caller's CWD within the worktree.
worktree_root="$(cd "$(dirname "$0")/.." && pwd)"
env_source="$HOME/dotfiles/repos/devbox/.env"

cd "$worktree_root"

npm install
npm run build

if [[ -f "$env_source" ]]; then
  ln -sfn "$env_source" "$worktree_root/.env"
  echo "linked .env ← $env_source"
else
  echo "warn: central env not found at $env_source — .env not linked" >&2
fi