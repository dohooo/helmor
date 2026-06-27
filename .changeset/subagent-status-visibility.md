---
"helmor": patch
---

Make background subagent (Task/Agent) runs legible in the chat:

- Fold a run's lifecycle into one collapsible block, collapsed by default, so the thread no longer jumps as the subagent streams progress.
- Never leak the internal "Async agent launched…" launch acknowledgment — backgrounded agents read as "running in background" instead.
- Show a single live status card (running / done / failed) instead of scattered notices, and label a run cut short by an app restart as "interrupted" rather than a misleading "failed".
