#!/usr/bin/env bash
set -euo pipefail

# Copy a skill onto disk. Best-effort: a registry or network hiccup for a single
# skill must not abort dependency setup (this script runs from worktree:setup and
# from the Cloud Agent environment install).
add_skill() {
  if ! npx --yes skills add "$@" -y --copy --agent claude-code cursor; then
    echo "install-skills: skipped 'skills add $*' (command failed)" >&2
  fi
}

# Project-specific third party
add_skill vercel/sandbox --skill sandbox

# NOTE: - First-party project-specific skills are git-tracked
#       - Workflow skills and plugins should be boot-strapped with
#         `npx @gannonh/agent-setup install`