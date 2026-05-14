---
"helmor": patch
---

Inject per-workspace `HELMOR_PORT` and `HELMOR_PORT_COUNT` env vars into run/setup scripts and embedded terminals so dev servers in parallel workspaces bind deterministic, non-overlapping port ranges.
