#!/usr/bin/env bash
# Install the plan-build-verify product OS skills for a GitHub-issue product repo.
#
# Project-local only (no -g). Non-interactive (-y). Installs only:
#   plan-build-verify, address-pr-comments
# Does not install ps, okf, or kata-linear. Do not install the whole gannonh/skills pack.
#
# Copy this script into a product repo as scripts/install-skills.sh, or run the
# equivalent npx command from AGENTS.md / conventions.md.
#
# Usage:
#   bash scripts/install-skills.sh

set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Never pass -g. Cloud agent VMs need per-project installs.
exec npx skills add gannonh/skills \
  --skill plan-build-verify \
  --skill address-pr-comments \
  -y
