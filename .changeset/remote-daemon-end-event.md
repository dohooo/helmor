---
"helmor": patch
---

Fix remote chat hanging on the heartbeat watchdog: the daemon's event reader was treating the SDK's `result` event as the lifecycle terminator and removing the session before the sidecar's trailing `end` event arrived, so the desktop's stream loop (which only matches `end`/`aborted`) never saw its terminator and the 45-second heartbeat watchdog gave up instead. Only `end` and `aborted` close the session at the daemon layer now — `result` rides through as data.
