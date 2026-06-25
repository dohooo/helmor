---
"helmor": minor
---

Support local git repositories that have no remote, including worktree workspaces.

- Open a git repo with no remote configured — branches, diffs, commits, and worktrees all work, with the default branch read from local HEAD.
- Push, pull, fetch, pull requests, and the forge Connect prompts are hidden for these local-only repos; repo settings show a "Local-only repository" notice and a local-branch picker.
