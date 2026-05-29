---
"helmor": minor
---

Upgrade the bundled agent CLIs and add Claude Opus 4.8.

- Claude Opus 4.8 (1M context) is now the default Claude model, listed above Opus 4.7 and 4.6 in the model picker.
- Bundled Claude Code 2.1.139 → 2.1.154, Claude Agent SDK 0.2.139 → 0.3.154, and Codex 0.130.0 → 0.134.0.
- Claude task lists now arrive as the incremental Task tools (TaskCreate/TaskUpdate) instead of TodoWrite; they render as the same single evolving plan widget as before.
- Codex 0.134 drops support for legacy `[profiles]` config sections. If you hand-edited `~/.codex/config.toml` with a `[profiles]` block, migrate it to the profile v2 format.
