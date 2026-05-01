---
"helmor": minor
---

Replace the single GitHub OAuth identity with multi-account support across both forges:
- Sign in with multiple GitHub and/or GitLab accounts at once via the bundled `gh` / `glab` CLIs; each repository automatically binds to whichever account has access.
- Remove the GitHub OAuth device-flow sign-in entirely.
- Workspace branch chips display the bound account's avatar so it's clear which identity is acting on each workspace.
- Connecting an account from the inspector or repo settings now opens an in-app terminal dialog instead of launching the system Terminal app.
- Branch prefix moves out of the global Git settings and into each repository's Settings panel, so different repos can use different prefixes.
