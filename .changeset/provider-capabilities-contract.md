---
"helmor": patch
---

Replace scattered `provider === "codex"` / `provider === "cursor"` checks with a data-driven provider-capability table exposed through a new `list_provider_capabilities` command, so adding a new provider becomes a single matrix edit instead of a codebase-wide grep.
