---
"helmor": patch
---

Track every PTY-backed script and embedded-terminal process in a new `runtime_processes` table so a crash-recovery sweep on launch can identify stale processes from a prior run. Probes PIDs via `kill(pid, 0)`, marks dead rows ended automatically, and logs "maybe alive" rows — no auto-kill on startup since PIDs can be reused.
