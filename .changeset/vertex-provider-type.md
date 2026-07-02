---
"helmor": minor
---

Add a Vertex AI provider type for Claude Code custom providers:
- When adding a provider, you can now pick "Vertex AI" and point Claude Code at a Vertex endpoint or LLM gateway with your GCP project ID.
- The gateway token can be stored as plain text or in the macOS Keychain — Keychain setup runs in an in-app terminal, and Claude Code reads the token directly so it never passes through Helmor.
