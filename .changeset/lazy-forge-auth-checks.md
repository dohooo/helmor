---
"helmor": patch
---

Make GitHub/GitLab sign-in checks lazy to cut background CLI churn:
- Helmor no longer runs `gh` / `glab auth status` in the background on window focus and inspector refreshes.
- Forge sign-in is now verified when you create, reopen, merge, or close a PR/MR; a signed-out account surfaces a Connect prompt at that point instead of failing silently.
