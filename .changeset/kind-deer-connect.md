---
"helmor": minor
---

Smooth out the add-repo and forge connect flows:
- Adding a repository now lands on the start page with the new repo selected, instead of auto-creating a workspace.
- Fix the GitHub / GitLab "Connect" button staying stuck after sign-in for accounts whose token can read the repo but doesn't expose membership in the API response.
