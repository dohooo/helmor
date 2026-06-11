---
"helmor": patch
---

Fix composer input-history recall stealing arrow keys in multi-line drafts.

- Arrowing back down through history to a multi-line in-progress draft no longer loses the cursor.
- ArrowUp on a blank Shift+Enter line now moves the caret up instead of recalling history.
