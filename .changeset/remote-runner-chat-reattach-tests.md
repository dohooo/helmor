---
"helmor": patch
---

`AgentStreamEvent`'s `Done` / `Aborted` / `UserInputRequest` variants now serialize their fields as `camelCase` to match the frontend's TypeScript types — serde's enum-level `rename_all` doesn't propagate into struct variants, so each one needed an explicit per-variant attribute. The chat's existing fallbacks (`event.sessionId ?? targetSessionId`) papered over the snake_case wire shape until the new reattach loop integration test surfaced it.
