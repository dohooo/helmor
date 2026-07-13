---
"helmor": patch
---

Fix the team-mode workspace inspector always showing an empty git state ("No changes on this branch yet" / "Branch not published to remote") no matter what the agent committed: the container's git-snapshot mirror sat behind `on_ui_mutation`'s no-target early-return, so the `WorkspaceGitStateChanged` / `WorkspaceFilesChanged` events that carry no session/workspace target never reached it and the D1 mirror was never written.
