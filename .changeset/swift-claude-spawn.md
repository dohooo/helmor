---
"helmor": patch
---

Fix a dev-mode EACCES crash on first sidecar spawn when the upstream Claude Code wrapper's postinstall stub wasn't replaced (Nix sandbox, multi-worktree setups, `--ignore-scripts` installs); release builds were unaffected.
