---
"helmor": patch
---

Fix a leak where OpenCode server processes could pile up over time — Helmor now reliably shuts them down and clears any left orphaned by a previous run.
