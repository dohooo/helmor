---
"helmor": patch
---

Fix PR / MR merge failing because the merge call wasn't telling the server which method to use, and surface the actual server reason in the toast instead of a generic "merge failed."

- GitHub: query the repo's allowed merge methods and pass `mergeMethod` (MERGE → SQUASH → REBASE) instead of relying on GitHub's default — fixes "Merge commits are not allowed on this repository."
- GitLab: read the project's `squash_option` and pass `squash=true` when it's `always` or `default_on` — fixes "Squash commits is required for this project."
- Toast errors from any Tauri command now include the full anyhow chain (e.g. `mergePullRequest failed: gh api graphql failed: <real reason>`), not just the outermost `.context(...)` label.
