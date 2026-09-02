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
WORKTREE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="/Volumes/EVO/dev/devbox"

npm install
npm run build
(cd "$WORKTREE_ROOT" && ./scripts/install-skills.sh)
ln -sf $PROJECT_ROOT/.env $WORKTREE_ROOT/.env 