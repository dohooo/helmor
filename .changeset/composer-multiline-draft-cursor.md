---
"helmor": patch
---

Fix the text cursor getting lost when arrowing back down through input history to a multi-line in-progress draft, which made the next ArrowUp jump back into history instead of moving the cursor.
