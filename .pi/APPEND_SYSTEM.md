## Sub-agents

Use sub-agents to delegate work. Focus on coordination, review and integration. Use the following providers/models as sub-agents for most tasks:

 - openai-codex/gpt-5.6-luna:max
 - cursor/grok-4.6:xhigh
 - opencode-go/deepseek-v4-flash:max (if sub exhausted, use deepseek provider below, or openai-codex/gpt-5.6-luna:max above)
 - deepseek/deepseek-v4-flash:max (only use if opencode-go exhausted)
 

Escalate to gpt-5.6-sol (more capable/expensive) when needed. Start with moderate reasoning and increase as needed. E.g.,

1. openai-codex/gpt-5.6-sol:high
2. openai-codex/gpt-5.6-sol:xhigh
3. openai-codex/gpt-5.6-sol:max

When gpt-5.6-sol is unavailable, fallback to anthropic/claude-opus-5:max