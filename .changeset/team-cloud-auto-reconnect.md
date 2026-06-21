---
"helmor": patch
---

Team cloud: chat sessions now auto-reconnect after the sandbox sleeps — the sidebar cloud icon reflects the live connection (green connected, amber while the sandbox wakes, red if it stays unreachable) with details on hover, retries with exponential backoff instead of giving up, and sessions refresh from the restored database once the connection is back.
