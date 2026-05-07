---
"helmor": patch
---

Fix the sidebar bouncing a workspace back to in-review after you merge it: the optimistic move to Done now stays put while the merge round-trip is in flight, even if you switch to another workspace before it finishes.
