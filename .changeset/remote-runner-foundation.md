---
"helmor": minor
---

Helmor gains first-class remote runtime support: connect to a `helmor-server` over SSH (or any Command-shaped wrapper like Teleport, Tailscale SSH, or `kubectl exec`), see live runtime health + connection state in a dev-only Runtime Debug panel, open persistent terminals that survive desktop reconnects, and have the registry persist across restarts. Auto-installs `helmor-server` on first connect when missing.
