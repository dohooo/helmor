---
"helmor": patch
---

Polish the model picker in Providers settings:
- Model search now uses plain text matching instead of fuzzy matching, so multi-word queries like "opencode go" return the models you expect.
- Add an "Unselect all" button to clear every picked model at once.
- Fix the Cursor model picker incorrectly showing each model as its own group.
