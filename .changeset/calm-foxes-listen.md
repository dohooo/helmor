---
"helmor": patch
---

Fix three pause-for-user-input bugs:
- Claude `AskUserQuestion` answers now reach Claude reliably instead of intermittently failing with an API error or empty user turn.
- Codex MCP elicitation forms now surface in Bypass Permissions mode instead of being auto-declined.
- Claude now sees project-scope MCP servers registered for your repo in `~/.claude.json`.
