---
"helmor": minor
---

Ship the GitHub inbox, redesigned workspace start page, and Local workspaces:
- Add a GitHub inbox that lists real issues, pull requests, and discussions per linked account, with sub-tab toggles, search and label filters, per-repo scoping, and detail previews you can drop straight into the composer.
- Redesign the workspace start page around a context sidebar that exposes the inbox and source-detail previews next to a mode picker, branch picker, and Create-and-checkout-new-branch dialog whose checkout is deferred until you submit.
- Add Local workspace mode — the agent operates directly on your source repo without a worktree — plus a right-click "Move into a new worktree" flow that relocates a Local workspace into its own worktree without touching the source repo.
- Fix a sidecar zombie-process bug where a closed parent pipe blocked auto title generation and branch rename after the first message.
