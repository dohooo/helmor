---
"helmor": patch
---

Fix background subagents and background shell commands being killed when an agent finishes its turn — they now run to completion and report their results back instead of silently dying.
