---
"helmor": patch
---

Add backend support for creating a worktree-mode workspace from an existing local branch via a new `branchIntent: "useExistingBranch"` parameter on `prepareWorkspaceFromRepo`, so the workspace reuses the branch as-is instead of always allocating a fresh auto-named branch.
