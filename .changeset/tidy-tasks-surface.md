---
"helmor": minor
---

Give Claude background tasks a proper home above the composer:
- A compact task bar shows the task in flight with live progress and status, expanding into a per-task detail view — command, terminal output, subagent instructions and report, metrics, and a clickable output file that opens in the editor.
- Task states survive session switches and app restarts, and raw "task_updated" system noise no longer leaks into the chat.
- Stopping a background task now shows a clear Killed state instead of hanging in Running, and sessions end cleanly once their background tasks finish.
- Goal banner and queued follow-ups now dock cleanly against the composer, with only the bottom-most bar keeping its open edge.
