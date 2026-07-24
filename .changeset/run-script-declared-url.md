---
"helmor": patch
---

Let run scripts declare their own URL for the Open menu by printing `helmor:url=<URL>` on a line of their own — useful for reverse-proxy dev setups (portless, Caddy, ngrok, Tailscale Funnel) where Helmor's sniffed `localhost:PORT` banners are ephemeral ports that aren't reachable through the proxy. Declared URLs accept any host and fully replace the sniffed ones.
