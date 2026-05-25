---
"helmor": minor
---

Let coding agents operate Helmor itself:
- Agents now know they're running inside Helmor (current workspace, target branch, linked directories) and can use the bundled `helmor-cli` skill to spawn sibling workspaces, dispatch ship actions, search sessions across all workspaces, and read other agents' transcripts.
- `helmor-cli` gains three new commands: `workspace run-action` (six ship flows including agent-dispatched commit-and-push, create-pr, fix-errors, and resolve-conflicts), `session search`, and `session get-messages` with windowing and body truncation for paging through long transcripts.
- New workspaces ship with a gitignored `.agent-contexts/` directory so agents can leave files for other sessions (or themselves later) without polluting diffs.
- Helmor CLI and Helmor Skills now install automatically during onboarding — no buttons to click — and a reinstall panel lands in Settings → Experimental for recovery.
