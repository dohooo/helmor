---
"helmor": patch
---

Fix Codex MCP tool-call approvals showing only Cancel/Decline. The empty-schema elicitation Codex sends with `_meta.codex_approval_kind: "mcp_tool_call"` now renders a dedicated Allow / Allow-for-session / Always-allow / Cancel panel, and the chosen persist option round-trips back to Codex so "remember this" actually sticks.
