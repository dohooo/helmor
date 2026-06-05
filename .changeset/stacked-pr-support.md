---
"helmor": minor
---

Add stacked PR support — work on a chain of small, dependent PRs instead of one big branch:
- `/helmor-cli stack` plans a large change as a stack of dependent PRs, and `/helmor-cli break` splits a change you've already written into one. Each layer is its own workspace and PR, and the workspace you start from becomes the stack's base.
- `/helmor-cli restack` re-syncs the layers above after a lower one changes or merges.
- The sidebar groups a stack's workspaces together, and each layer's header points at the workspace it builds on.
