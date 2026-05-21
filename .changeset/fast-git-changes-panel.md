---
"helmor": patch
---

Make the Git Changes panel faster and more stable on large workspaces:
- Lazy-load diff contents and virtualize the changes list to reduce CPU work.
- Keep row animations from replaying during virtualized scrolling and preserve filename-specific icons.
