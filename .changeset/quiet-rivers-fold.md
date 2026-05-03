---
"helmor": patch
---

Tighten up the workspace archive flow:
- Fix archive failing with "Directory not empty" when archiving a workspace that was just restored in the same session, by giving each trash directory a unique name instead of reusing the process-id suffix.
- Offer "Permanently Delete" as a recovery action whenever archive fails, matching the restore-failure behavior, so a stuck cleanup never leaves the workspace unremovable until app restart.
