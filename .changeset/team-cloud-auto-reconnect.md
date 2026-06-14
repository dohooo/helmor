---
"helmor": patch
---

Team cloud: chat sessions now auto-reconnect after the sandbox sleeps — a thin "reconnecting" banner shows while the sandbox wakes (with exponential backoff instead of giving up), and sessions refresh from the restored database once the connection is back.
