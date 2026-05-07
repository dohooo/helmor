---
"helmor": patch
---

Fix agent sends that resume from an existing session without an explicit working directory so they reopen in that session's workspace and report broken workspaces instead of falling back to the app cwd.
