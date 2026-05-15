---
"helmor": patch
---

Fix the inspector's Staged Changes / Changes diff when the same file appears in both areas:
- Each area now shows its own diff (HEAD ↔ index for Staged, index ↔ working tree for Unstaged) instead of a combined HEAD ↔ working-tree view that mixed both.
- Clicking the same file across the two areas now actually switches the diff, and the selection highlight only marks the row whose diff is open.
- Opening a file from a chat link no longer inherits stale bytes from a diff view, closing a path where saving could overwrite unstaged edits.
