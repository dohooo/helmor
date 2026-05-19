---
"helmor": minor
---

Adds a `workspace.search` RPC backed by `git grep` so remote-bound workspaces can run case-insensitive / fixed-string / max-results-capped text searches with the same gitignore + binary-skipping semantics as local ones. Frontend API wrapper ships today; the search panel UI is a follow-on slice.
