---
"helmor": patch
---

Make the Connect GitHub/GitLab state reliable:
- A transient API 401 no longer flips a workspace to "Connect" — Helmor now re-validates the account with the forge CLI before treating it as logged out.
- When an account logout is detected, every workspace of the same repository updates together instead of showing inconsistent Connect states.
