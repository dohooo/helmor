# Durable Active Plan State

Related issue: [#410](https://github.com/dohooo/helmor/issues/410)

## Goal

Persist the current agent plan as a first-class backend object so long-running sessions can show a pinned active plan, survive reloads, and offer continuation actions.

Helmor already normalizes plan-like artifacts:

- Codex `turn/plan/updated` and plan items become todo-list style blocks.
- `ExitPlanMode` becomes a persisted `plan-review` part.
- The pipeline has snapshot coverage for provider event shapes.

The missing piece is a durable session-level "current plan" projection.

## Pi-Informed Principle

Pi does not treat the plan as chat decoration. Missions and validation contracts are state: assertions, workers, validators, arena scores, and evidence can be queried independently of the transcript.

Helmor should not make React rediscover the active plan by scanning scrollback. The backend should maintain a small projection from existing stream events.

## Proposed Data Model

Add `session_plan_state`:

```sql
CREATE TABLE IF NOT EXISTS session_plan_state (
    session_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_message_id TEXT,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`plan_json` should be typed in Rust before writing. A first shape:

```json
{
  "items": [
    { "id": "1", "text": "Inspect backend", "status": "completed" },
    { "id": "2", "text": "Add schema", "status": "inProgress" }
  ],
  "currentItemId": "2",
  "allowedPrompts": ["Continue plan", "Revise plan"],
  "rawSource": "codex"
}
```

## MVP Behavior

1. Detect plan updates in the Rust pipeline or streaming event loop.
2. Project the latest plan into `session_plan_state`.
3. Publish `UiMutationEvent::SessionPlanChanged { session_id }`.
4. Add a Tauri command to load the active plan for a session.
5. Keep the chat message storage shape unchanged except for existing pipeline messages.

## Continuation Commands

Add backend helpers that return prompt text rather than immediately sending:

- `continuePlan`: "Continue working through the current plan. Start from the first pending item..."
- `revisePlan`: "Revise the current plan before continuing..."

This keeps the first PR backend-safe and avoids unexpected agent sends.

## Backend Touch Points

- `src-tauri/src/pipeline/accumulator/*`
- `src-tauri/src/pipeline/adapter/*`
- `src-tauri/src/agents/streaming/mod.rs`
- `src-tauri/src/agents/persistence.rs`
- `src-tauri/src/schema.rs`
- `src-tauri/src/ui_sync/events.rs`
- `src/lib/api.ts`
- `src-tauri/tests/pipeline_scenarios.rs`
- `src-tauri/tests/pipeline_streams.rs`

## Test Plan

- Pipeline snapshot: Codex plan update creates the same rendered message as today.
- New Rust unit test: plan projection extracts item statuses from a Codex plan update.
- Schema migration snapshot for `session_plan_state`.
- UI sync serialization test for `SessionPlanChanged`.
- Historical reload test: session plan state survives app restart.

Any change touching pipeline or storage shape needs snapshot coverage in `src-tauri/tests/`.

## PR Shape

1. Backend projection and command, no pinned UI.
2. Frontend pinned plan view.
3. Continuation action buttons.

The first PR should be useful on its own because it creates a stable API and persisted state for #410.

