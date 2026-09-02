#!/usr/bin/env bash
set -euo pipefail

# Copy a skill onto disk. Best-effort: a registry or network hiccup for a single
# skill must not abort dependency setup (this script runs from worktree:setup and
# from the Cloud Agent environment install).
add_skill() {
  if ! npx --yes skills add "$@" -y --copy --agent claude-code cursor codex; then
    echo "install-skills: skipped 'skills add $*' (command failed)" >&2
  fi
}

# Shared workflow skills from @gannonh/agent-setup (thermo-run, readme, review skills, etc.).
# Published CLI has no --skills flag, so run its install-skills.sh from the package.
bootstrap_shared_skills() {
  local tmpdir tarball unpack script
  tmpdir="$(mktemp -d)"
  if ! npm pack @gannonh/agent-setup --pack-destination "$tmpdir" --silent >/dev/null 2>&1; then
    echo "install-skills: skipped @gannonh/agent-setup shared skills (npm pack failed)" >&2
    rm -rf "$tmpdir"
    return 0
  fi
  tarball="$(ls "$tmpdir"/*.tgz)"
  unpack="$(mktemp -d)"
  tar -xzf "$tarball" -C "$unpack"
  script="$unpack/package/scripts/install-skills.sh"
  if [[ ! -f "$script" ]]; then
    echo "install-skills: skipped @gannonh/agent-setup shared skills (missing install-skills.sh)" >&2
    rm -rf "$tmpdir" "$unpack"
    return 0
  fi
  if ! bash "$script"; then
    echo "install-skills: skipped @gannonh/agent-setup shared skills (script failed)" >&2
  fi
  rm -rf "$tmpdir" "$unpack"
}

bootstrap_shared_skills

# plan-build-verify is required for spec-driven work but not yet in @gannonh/agent-setup's skill pack.
add_skill gannonh/skills --skill plan-build-verify

# Project-specific third party
add_skill vercel/sandbox --skill sandbox
