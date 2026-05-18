---
"helmor": minor
---

Workspaces bound to a remote runtime now run their `claude-code` / `codex` / `cursor` agent on the remote machine — prompts dispatch over SSH to a sidecar on the daemon, output streams back through the existing chat pipeline, and SDK API keys live remote-side in `~/.helmor/server/secrets.json` instead of the desktop's settings DB.
