---
"helmor": patch
---

Stop run-script and embedded-terminal process groups on graceful quit so dev servers, watch processes, and shell sessions don't outlive Helmor as orphan process trees.
