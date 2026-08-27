# pstack model configuration

This Codex parent uses native `spawn_agent` routes only. This sheet is authoritative for pstack role routing in Codex and overrides the plugin's bundled first-run model matrix. Every explicit descriptor uses the `codex` provider.

The default lane is `codex:gpt-5.6-luna@max`. Escalation uses `codex:gpt-5.6-sol` at `medium`, `high`, or `xhigh`. Do not use Sol at `max` or `ultra`. Do not route a configured role through Claude or Grok. Terra remains available for a future explicit assignment.

`inherit-parent` uses the current Codex model and effort. Why and Reflect keep this alias so their workers retain the parent's MCP tools.

feature, refactoring: codex:gpt-5.6-luna@max
bug-fix: codex:gpt-5.6-luna@max
perf-issue: codex:gpt-5.6-sol@medium
hillclimb: codex:gpt-5.6-sol@high
judgment and prose: codex:gpt-5.6-luna@max
hardest tasks: codex:gpt-5.6-sol@xhigh
how explorer: codex:gpt-5.6-luna@max
how explainer: codex:gpt-5.6-luna@max
how critics: codex:gpt-5.6-luna@max, codex:gpt-5.6-sol@medium, codex:gpt-5.6-sol@high, codex:gpt-5.6-sol@xhigh
why investigators, synthesizer: inherit-parent
reflect tooling, judgment, divergent, synthesizer: inherit-parent
arena runners: codex:gpt-5.6-luna@max, codex:gpt-5.6-sol@medium, codex:gpt-5.6-sol@high, codex:gpt-5.6-sol@xhigh
arena cross-judge pool: codex:gpt-5.6-luna@max, codex:gpt-5.6-sol@medium, codex:gpt-5.6-sol@high, codex:gpt-5.6-sol@xhigh
swarm workers: codex:gpt-5.6-luna@max
architect runners: codex:gpt-5.6-luna@max, codex:gpt-5.6-sol@medium, codex:gpt-5.6-sol@high, codex:gpt-5.6-sol@xhigh
interrogate reviewers: codex:gpt-5.6-luna@max, codex:gpt-5.6-sol@medium, codex:gpt-5.6-sol@high, codex:gpt-5.6-sol@xhigh
