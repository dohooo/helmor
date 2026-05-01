---
"helmor": patch
---

Fix file and image attachments whose absolute paths contain whitespace (a common case for macOS Finder drops like `Application Support/...` or CleanShot screenshots) — they now round-trip end-to-end without being truncated, and steer turns keep their image badges after a reload.
