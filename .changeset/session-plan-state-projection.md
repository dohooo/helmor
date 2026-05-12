---
"helmor": patch
---

Persist the latest agent plan per session in a new `session_plan_state` table so a future pinned-plan UI can survive reloads. The pipeline projects Codex `turn/plan/updated` events and Claude `ExitPlanMode` tool calls into a normalised plan shape and exposes it through a new `getSessionPlanState` command and `sessionPlanChanged` UI sync event; the chat transcript's existing plan rendering is unchanged.
