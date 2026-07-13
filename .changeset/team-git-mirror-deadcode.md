---
"helmor": patch
---

Fix the team-mode workspace inspector always showing an empty git state ("No changes on this branch yet" / "Branch not published to remote") no matter what the agent committed. Two causes: the container's D1 git-snapshot mirror sat behind `on_ui_mutation`'s no-target early-return (dead code — never written), and the cloud auto-push never announced the git change it made, relying on a container fs-watcher that doesn't fire reliably. The mirror now runs before the early-return, and a successful auto-push directly publishes `WorkspaceGitStateChanged` so team clients re-read the real git state.
