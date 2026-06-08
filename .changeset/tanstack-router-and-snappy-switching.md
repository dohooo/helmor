---
"helmor": patch
---

Workspace switching stays smooth when rapidly cycling through many workspaces (e.g. holding ⌥⌘↑/↓ through the Archived list): the per-workspace data load now waits for you to settle on a workspace instead of firing for every workspace you pass through, so a held burst no longer stutters while the highlight keeps moving per keypress.
