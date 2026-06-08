---
"helmor": patch
---

Snappier UI and memory-leak fixes:
- Holding ⌥⌘↑/↓ to cycle workspaces/sessions now stops the instant you release the key (no backlog of queued steps), while a held key still scrubs smoothly frame-by-frame.
- Opening a workspace whose conversation contains code no longer briefly freezes — syntax highlighting is computed off the first paint, so the thread appears immediately and highlights a moment later (identical result).
- Fixed two leaks: an orphaned background refresh timer left running when a send fails at the IPC layer, and an app-update listener left attached when Settings closes before it finishes connecting.
- Lighter typing and streaming: the composer no longer walks the whole document on every caret move, and the conversation's live-stream state uses a single store subscription instead of six.
