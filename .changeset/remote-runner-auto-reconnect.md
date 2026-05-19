---
"helmor": minor
---

Disconnected remote runtimes now auto-reconnect in the background and surface a top-of-shell banner with a Reconnect now button. When the liveness loop drops a remote to `Disconnected`, a new auto-reconnect loop retries `connect_from_config` with exponential backoff (5s → 5m cap) until the network heals or the user removes the entry — the same "shows a banner and resumes" UX the major remote-dev providers ship.
