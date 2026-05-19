---
"helmor": minor
---

Inspector cache now refreshes on real file changes instead of polling. Every open workspace gets a file watcher (in-process for local workspaces, dispatched over SSH via `workspace.startWatch` for remote ones); each debounced batch of changes invalidates the `workspaceChanges` / `workspaceFileTree` / `workspaceGitActionStatus` React Query keys, so the changes panel reflects edits as soon as the debouncer flushes.
