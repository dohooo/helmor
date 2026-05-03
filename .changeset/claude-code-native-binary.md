---
"helmor": patch
---

Bump bundled agent CLIs and add Codex `/goal` support:

- Bump Claude Code from 2.1.111 to 2.1.126 and switch to its new platform-native binary distribution.
- Bump Codex from 0.124.0 to 0.128.0.
- Add a Codex `/goal` slash command (set, pause, resume, clear, optional `--tokens` budget) that drives the new `thread/goal/*` JSON-RPC API, plus a thread-header banner showing the active goal's status and token usage.
