---
"helmor": patch
---

Fix two sidebar unread-indicator gaps:
- Chat rows now show the unread / interaction-required dot (hidden on hover so the archive icon can take its place); previously the dot had no carrier on chat entries and was silently dropped.
- Background-completed sessions stay marked unread on every follow-up turn instead of only the first one — read-state was keying off the provider's resume token (non-null from the second turn onward), so subsequent completions no-op'd against the DB.
