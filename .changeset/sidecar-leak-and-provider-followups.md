---
"helmor": patch
---

Fix a sidecar process leak and refine provider behavior.

- The sidecar now tears down its provider servers and exits when the parent process goes away, fixing leaked OpenCode `serve` processes (and their memory) when an app instance dies.
- Kimi now generates real, model-written session titles and branch names (preferring the configured custom model), consistent with the other agents.
- OpenCode and MiMo show "Ready" only after an actual sign-in, so the Login action stays available when only environment variables or custom providers are configured.
