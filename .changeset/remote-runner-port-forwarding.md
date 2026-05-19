---
"helmor": minor
---

Remote-side dev servers can now be reached at `localhost:N` on the desktop. A new Port forwards panel in Settings → Runtime Debug spawns `ssh -O forward` against the runtime's existing ControlMaster connection — no parallel SSH session, no new auth handshake, and forwards persist across desktop restarts. SSH-shaped runtimes only; Command transports (Teleport, Tailscale SSH, kubectl exec) surface a hint pointing at the wrapper's own forwarding tool.
