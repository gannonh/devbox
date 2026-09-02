#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Copy a skill onto disk. Best-effort: a registry or network hiccup for a single
# skill must not abort dependency setup (this script runs from worktree:setup and
# from the Cloud Agent environment install).
add_skill() {
  if ! npx --yes skills add "$@" -y --copy --agent claude-code cursor; then
    echo "install-skills: skipped 'skills add $*' (command failed)" >&2
  fi
}

# plan-build-verify is a Cursor/Claude/Codex plugin, not a gannonh/skills pack entry.
# Cursor: marketplace add gannonh/plan-build-verify (Team Marketplace git import).
# Headless setup clones plugins/cursor into the local plugin directory.
install_plan_build_verify_plugin() {
  local dest="${HOME}/.cursor/plugins/local/plan-build-verify"
  local tmp
  tmp="$(mktemp -d)"

  cleanup() {
    rm -rf "$tmp"
  }
  trap cleanup RETURN

  if ! git clone --depth 1 --filter=blob:none --sparse \
    https://github.com/gannonh/plan-build-verify.git "$tmp" 2>/dev/null; then
    echo "install-skills: skipped plan-build-verify plugin (git clone failed)" >&2
    return 0
  fi

  if ! git -C "$tmp" sparse-checkout set plugins/cursor 2>/dev/null; then
    echo "install-skills: skipped plan-build-verify plugin (sparse-checkout failed)" >&2
    return 0
  fi

  mkdir -p "$(dirname "$dest")"
  rm -rf "$dest"
  cp -R "$tmp/plugins/cursor" "$dest"
}

install_plan_build_verify_plugin

# gannonh/skills
add_skill gannonh/skills --skill thermo-run
add_skill gannonh/skills --skill readme

# cursor/plugins
add_skill cursor/plugins --skill thermo-nuclear-code-quality-review
add_skill cursor/plugins --skill thermo-nuclear-review
add_skill cursor/plugins --skill unslop

# misc
add_skill anthropics/claude-plugins-community --skill eli5
add_skill humanlayer/skills --skill show-me
add_skill warpdotdev/common-skills --skill skill-doctor

# Project-specific third party

add_skill vercel/sandbox --skill sandbox
