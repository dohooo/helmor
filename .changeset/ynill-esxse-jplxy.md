---
"helmor": patch
---

Fix sidecar startup crash introduced in v0.20.0 where adding the Cursor provider caused the sidecar to exit immediately with "Invalid sidecar ready signal" due to a native sqlite3 addon that cannot load inside a compiled Bun binary.
