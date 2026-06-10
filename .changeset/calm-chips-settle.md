---
"helmor": patch
---

Fix Claude streaming render glitches introduced by the claude-code 2.1.170 upgrade:
- Thinking phases no longer render as a run of duplicated "Thought for Ns" chips — split thinking segments now merge into one chip with the real total duration.
- Edits no longer leave phantom "+0 -0" cards spinning forever after the turn has finished.
- Collapsed read/search groups now stay in chronological order instead of jumping below thinking that happened later.
