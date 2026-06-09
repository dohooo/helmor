---
"helmor": patch
---

Cursor now retries transient network failures (Cursor's API occasionally resets the connection) instead of failing the turn, and a dropped connection no longer crashes the Cursor worker with "Cursor worker exited unexpectedly".
