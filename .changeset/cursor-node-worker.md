---
"helmor": patch
---

Fix Cursor tool calls (running shell commands, editing files, searching) failing — Cursor would chat normally but every tool call came back empty, as if its shell produced no output. Cursor now runs on a bundled Node runtime instead of Bun, which resolves it.
