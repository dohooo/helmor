---
"helmor": patch
---

Fix the top-right Create PR / MR button getting stuck on "Create" after the pull request is already open:
- Creating PRs across several workspaces around the same time now reliably syncs each one's PR and CI status and auto-closes its action session, instead of only the last workspace you triggered.
- A workspace whose branch is already pushed to the remote now detects its open PR even when the local clone is missing the remote-tracking ref.
