---
"helmor": patch
---

Fix a bug where a workspace on a shared branch like `main` could be mis-associated with — and auto-canceled by — an unrelated fork pull request that happened to use the same branch name.
