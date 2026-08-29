#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Copy a skill onto disk. Best-effort: a registry or network hiccup for a single
# skill must not abort dependency setup (this script runs from worktree:setup and
# from the Cloud Agent environment install).
add_skill() {
  if ! npx skills add "$@" -y --copy --agent claude-code cursor; then
    echo "install-skills: skipped 'skills add $*' (command failed)" >&2
  fi
}

# gannonh/skills
add_skill gannonh/skills --skill plan-build-verify
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

# plugins
# codex
# codex plugin marketplace add ericlitman/open-pstack --ref main
# codex plugin add pstack@open-pstack

# # claude
# claude plugin marketplace add ericlitman/open-pstack --scope project
# claude plugin install pstack@open-pstack --scope project -y

# # cursor (no plugin install CLI; copy official plugin onto disk)
# scripts/install-cursor-pstack.sh
