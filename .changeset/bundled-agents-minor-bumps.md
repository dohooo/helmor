---
"helmor": minor
---

Upgrade the bundled agents and CLIs, and support nested sub-agents:
- Claude Code 2.1.173 — sub-agents can now spawn their own sub-agents (up to 5 levels deep), and Helmor's conversation view nests each nested agent's activity under the Task that spawned it instead of flattening it to the top level. Also picks up upstream fixes for multi-image conversations and 1M-context sessions stuck without usage credits.
- Codex 0.139.0, opencode 1.17.3, gh 2.94.0, glab 1.102.0, cloudflared 2026.6.0.
