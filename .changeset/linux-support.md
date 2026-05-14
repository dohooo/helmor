---
"helmor": minor
---

Add native Linux desktop support (Ubuntu 22.04+) as a community fork:

- Ship Linux x86_64 `.deb` and `.AppImage` release artifacts from the fork's release pipeline.
- Read Claude OAuth credentials from `~/.claude/.credentials.json` on Linux instead of the macOS Keychain (no libsecret/D-Bus dependency).
- Wire "reveal in file manager" through `xdg-open`, and route clipboard actions through `wl-copy` (Wayland) / `xclip` (X11).
- Keep macOS releases unaffected — Linux changes are gated behind `#[cfg(target_os = "linux")]` and a separate publish workflow.
