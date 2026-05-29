---
"helmor": minor
---

Add GUI support for Claude Code Dynamic Workflows.

- Workflow runs render as an evolving in-thread card (phases, agents, token/duration footer).
- A new `/workflows` command opens an independent, keyboard-navigable drill-down above the composer — runs → phase-grouped agents → per-agent detail (model, tokens, tools, duration, and the agent's markdown-rendered result) — without sending a message; arrow keys navigate and Esc closes it.
- Typing a magic keyword like "workflow" or "ultrathink" in the composer highlights it with an animated gradient as a mode cue.
- The model picker now marks the active model with a checkmark.
- Workflow task lifecycle is persisted, so reopening a past conversation keeps the full workflow tree instead of a bare placeholder.
