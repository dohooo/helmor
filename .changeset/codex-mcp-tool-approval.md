---
"helmor": patch
---

Fix Codex MCP tool-call approvals showing no Allow button. The empty-schema elicitation with `_meta.codex_approval_kind: "mcp_tool_call"` now renders Allow / Allow-for-session / Always-allow / Decline, and the persist choice round-trips back so Codex remembers it.
