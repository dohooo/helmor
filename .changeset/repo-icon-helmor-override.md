---
"helmor": patch
---

Let workspaces opt out of icon auto-detection by committing a `.helmor/icon.svg` (or `.png`) — useful for monorepos where the existing heuristics pick the wrong sub-app's favicon, or none at all. Edits to the icon file are now also picked up without restarting the app, since the in-process icon cache is keyed on the file's mtime instead of being permanent.
