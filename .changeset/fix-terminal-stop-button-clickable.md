---
"helmor": patch
---

Fix the inspector Run/Setup tabs' floating Stop/Rerun button only registering clicks on a thin strip near its bottom edge. The xterm WebGL link-layer canvas sits at `z-index: 2` and was painted over the upper portion of the button — the button now sits above the xterm canvas stack so the entire visible rectangle is clickable.
