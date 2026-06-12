---
"helmor": patch
---

Make Terminal Mode launches more reliable:
- Consume the staged boot command at PTY spawn time so a terminal session can no longer open without the prompt it was launched with.
- Hide the Terminal Mode toggle on chat surfaces, where there is no repository to spawn a terminal in — submitting there left the session stuck on "Starting…".
