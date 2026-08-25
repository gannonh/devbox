#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npx skills add gannonh/skills --skill plan-build-verify --skill address-pr-comments --skill thermo-run --skill readme -y
npx skills add https://github.com/cursor/plugins --skill thermo-nuclear-code-quality-review -y
npx skills add https://github.com/cursor/plugins --skill thermo-nuclear-review -y
npx skills add https://github.com/cursor/plugins --skill unslop -y