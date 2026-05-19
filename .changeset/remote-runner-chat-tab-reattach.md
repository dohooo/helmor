---
"helmor": minor
---

Opening a workspace whose remote daemon is still streaming an agent turn now auto-attaches the chat to that turn — no more "I sent this 5 minutes ago, what happened?" frozen view after closing the laptop mid-stream. A new workspace-level hook queries `list_remote_agent_sessions` against the bound runtime on every session swap, opens `start_agent_message_reattach_stream` when a matching live turn exists, and feeds the cooked `AgentStreamEvent` envelopes into the chat's session-thread cache anchored against the persisted-history prefix. Terminal events refresh the thread from DB so the chat picks up whatever's now committed. A small "Following live remote turn" chip surfaces above the panel while the desktop is attached. Local workspaces skip the path entirely.
