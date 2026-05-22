---
"helmor": patch
---

Stop eagerly prefetching every changed file's contents when opening the Git Changes panel — Monaco now reads files on demand instead, cutting CPU and IPC traffic on large workspaces.
