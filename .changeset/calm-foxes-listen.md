---
"helmor": patch
---

Fix three pause-for-user-input bugs and unify how user-input requests are surfaced:
- Submitting answers to Claude's `AskUserQuestion` now reaches Claude reliably, instead of intermittently failing with an API error or producing a phantom empty user turn.
- MCP server elicitation requests forwarded through Codex (for example servers like `elicitation-demo`) now surface a real form for you to fill in, instead of being auto-declined within milliseconds. In Bypass Permissions mode, Helmor uses a granular Codex approval policy so elicitation forms reach you, and silently auto-accepts the empty-schema tool-call approvals Codex piggybacks on the same channel — so you only see the actual form, not a redundant "Allow this MCP tool?" pre-prompt.
- Project-scope MCP servers registered for your repo in `~/.claude.json` are now visible to Claude inside Helmor workspaces. Previously the SDK only saw user-scope MCPs because its project lookup uses `cwd`, and Helmor sessions run in the worktree (which never matches the repo path you registered the MCP under).
