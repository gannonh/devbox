#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# gannonh/skills
npx skills add gannonh/skills --skill plan-build-verify -y --copy --agent claude-code cursor
npx skills add gannonh/skills --skill thermo-run -y --copy --agent claude-code cursor
npx skills add gannonh/skills --skill readme -y --copy --agent claude-code cursor

# cursor/plugins
npx skills add cursor/plugins --skill thermo-nuclear-code-quality-review -y --copy --agent claude-code cursor
npx skills add cursor/plugins --skill thermo-nuclear-review -y --copy --agent claude-code cursor
npx skills add cursor/plugins --skill unslop -y --copy --agent claude-code cursor

# misc
npx skills add anthropics/claude-plugins-community --skill eli5 -y --copy --agent claude-code cursor
npx skills add humanlayer/skills --skill show-me -y --copy --agent claude-code cursor
npx skills add warpdotdev/common-skills --skill skill-doctor -y --copy --agent claude-code cursor

# plugins
# codex
codex plugin marketplace add ericlitman/open-pstack --ref main
codex plugin add pstack@open-pstack

# claude
claude plugin marketplace add ericlitman/open-pstack --scope project
claude plugin install pstack@open-pstack --scope project -y

# cursor (no plugin install CLI; copy official plugin onto disk)
scripts/install-cursor-pstack.sh

