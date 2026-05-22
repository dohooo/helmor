---
"helmor": patch
---

Reduce Git Changes panel CPU and rendering work on large workspaces.

- Stop eagerly prefetching every changed file's contents when opening the panel; Monaco now reads files on demand.
- Render the Git Changes file tree through a virtualized list so only visible rows and a small overscan window mount while scrolling.
