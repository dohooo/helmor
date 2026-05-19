---
"helmor": minor
---

Reattaching to a remote agent session can now surface the cooked `AgentStreamEvent` stream — the same envelope the chat's `useStreaming` consumes on a fresh send. A new `reattach_agent_message_stream` Tauri command pipes daemon events through `MessagePipeline` and emits `Update` / `StreamingPartial` / `Done` / `Aborted` / `Error` envelopes through an IPC channel; the Remote Agent Sessions panel gets a Chat preview button that renders the resulting messages in a chat-style preview, letting operators verify the wire-up before a future slice routes the same stream straight into the workspace chat tab.
