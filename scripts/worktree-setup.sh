#!/usr/bin/env bash
# Worktree setup — run from the worktree root after `git worktree add`.
#
#   git worktree add ../devbox-feature main
#   cd ../devbox-feature
#   npm run worktree:setup
#
# Installs dependencies, builds the package, and links the central .env
# from ~/dotfiles/repos/devbox/.env. Idempotent: safe to re-run.

set -euo pipefail

# Resolve the worktree root from the script location so it works regardless of
# the caller's CWD within the worktree.
worktree_root="$(cd "$(dirname "$0")/.." && pwd)"
env_source="$HOME/dotfiles/repos/devbox/.env"
env_target="$worktree_root/.env"

cd "$worktree_root"

npm install
npm run build

if [[ -e "$env_target" && ! -L "$env_target" ]]; then
  echo "refusing to replace existing regular .env at $env_target" >&2
  exit 1
fi

if [[ -f "$env_source" ]]; then
  ln -sfn "$env_source" "$env_target"
  echo "linked .env ← $env_source"
else
  echo "warn: central env not found at $env_source — .env not linked" >&2
fi