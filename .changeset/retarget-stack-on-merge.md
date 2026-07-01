---
"helmor": patch
---

Stacked workspaces now re-target automatically when their base PR merges — the layer above a merged PR moves onto that layer's own base (the repo default branch for a bottom-of-stack merge) instead of staying pinned to the now-merged branch, and stacks already left in this state are healed on launch.
