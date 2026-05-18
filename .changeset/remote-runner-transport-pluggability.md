---
"helmor": minor
---

Remote runtimes can now reach `helmor-server` via Teleport, Tailscale SSH, `kubectl exec`, or any other `Command`-shaped wrapper alongside the existing OpenSSH path, and the host-suggestions dropdown follows `Include` directives and `Match` blocks from `~/.ssh/config` so modular configs surface every alias the user has actually defined.
