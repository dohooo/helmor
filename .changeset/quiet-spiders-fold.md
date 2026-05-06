---
"helmor": patch
---

Fix a few rough edges:
- Custom workspace branch prefixes no longer auto-append a trailing `/`; the prefix you set is the prefix used.
- Codex sub-agents now render with their real nickname throughout (spawn, wait, etc.) instead of switching names partway through, and no longer flash a no-name "Sub-agent" placeholder while spawning.
