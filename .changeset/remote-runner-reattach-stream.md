---
"helmor": minor
---

Reattaching to a remote agent session now streams the daemon's live `agent.event` notifications back to the desktop. The Remote Agent Sessions panel renders an inline event log while a stream is active and exposes a Stop button on the streaming row; tearing down the subscription unhooks the runtime callback cleanly.
