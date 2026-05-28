---
"helmor": patch
---

Three fixes for sending prompts from the CLI and chatting outside a workspace:
- Fix `helmor send` failing with `Failed to borrow write connection: timed out waiting for connection` when an agent dispatches prompts to running workspaces.
- Fix concurrent CLI sends silently dropping every prompt past the first one — the App now picks up each queued prompt in turn instead of discarding the rest while only dispatching the oldest.
- Fix "Just Chat" sessions being told they were bound to a workspace with a working directory and a target branch, which previously led the agent into nonsensical `git` and PR commands.
