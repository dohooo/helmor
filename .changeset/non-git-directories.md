---
"helmor": minor
---

Add opt-in support for attaching sessions to plain local folders that are not git repositories.

- New "Non-git directories" setting (Settings → General). When enabled, Open project can attach a session to any local folder; these run as local-mode sessions with no branch/worktree actions.
- Harden agent process environment resolution so bundled CLIs find their PATH reliably (Windows PATH is rebuilt from the registry), and resolve git pointer paths correctly for Windows absolute and UNC paths.
