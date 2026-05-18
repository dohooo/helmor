//! User-controlled noise filter for SDK events.
//!
//! Single source of truth — three call sites consult this module:
//! - `accumulator::push_event` reads `SUPPRESSED_EVENT_TYPES` and drops
//!   matching top-level events before any handler runs (NoOp).
//! - `accumulator::handle_claude_system` reads `SUPPRESSED_SYSTEM_SUBTYPES`
//!   + local-bash task helpers on live ingest.
//! - `adapter::convert_system_msg` reads the same pair on historical
//!   reload, so old persisted noise rows from earlier code versions
//!   render with the same rules as new turns.
//!
//! Comment out a line to start surfacing that event again.

use serde_json::Value;

/// Top-level event types (Claude or Codex) that should be silently
/// dropped before any handler runs. The dispatch arms downstream still
/// exist — uncommenting an entry below activates them.
pub(crate) const SUPPRESSED_EVENT_TYPES: &[&str] = &[
    // OAuth re-auth flow notifications. No body fields the frontend
    // renders, the user explicitly opted out.
    "auth_status",
    // Predicted next-user-prompt the SDK emits when `promptSuggestions`
    // is enabled. The composer chip plumbing was rolled back; keep the
    // type silent so the wire stays clean even if the SDK option is
    // turned on later by accident.
    "prompt_suggestion",
];

/// Claude `system` subtypes that should be silently dropped.
pub(crate) const SUPPRESSED_SYSTEM_SUBTYPES: &[&str] = &[
    // Session-start banner. Frontend already shows the model picker, so
    // "Session initialized — claude-opus-4-7" is redundant.
    "init",
    // Hook lifecycle — fires on every PreToolUse / PostToolUse / etc.
    // Pure noise unless you're debugging the hook system itself.
    "hook_started",
    "hook_progress",
    "hook_response",
    // Internal turn-state machine signals — meaningful to the SDK, not
    // to the user.
    "session_state_changed",
    "files_persisted",
    "elicitation_complete",
    // Status pings (`{status: 'compacting' | null}`) — comment out to
    // surface the compacting indicator.
    "status",
    // Dead arm — not in `@anthropic-ai/claude-agent-sdk` v0.2.111's
    // `.d.ts`. The real lifecycle uses `task_notification`. Listed
    // defensively in case the SDK ever revives it.
    "task_completed",
    // ── To start showing one of these, comment out its line: ─────────
    // "task_started",         // subagent started
    // "task_progress",        // subagent step (folds into Task UI)
    // "task_notification",    // subagent completed/failed/cancelled
    // "compact_boundary",     // context compression notice
    // "api_retry",            // API retry warning
    // "local_command_output", // local command stdout/stderr
    // "tool_use_summary",     // tool output summarized for context
];

pub(crate) fn is_suppressed_event_type(event_type: &str) -> bool {
    SUPPRESSED_EVENT_TYPES.contains(&event_type)
}

pub(crate) fn is_suppressed_system_subtype(subtype: &str) -> bool {
    SUPPRESSED_SYSTEM_SUBTYPES.contains(&subtype)
}

/// `task_type: "local_bash"` lifecycle events are Claude wrapping a
/// single Bash command with its own started/progress/completed notices.
/// The `tool_use_id` on them points at the Bash tool call — which our
/// grouping pass doesn't treat as a parent — so they'd render as flat
/// "Subagent started / completed" siblings (mislabeled — these are not
/// subagents) right next to the real Bash tool call that already shows
/// the command. Pure duplication; drop them on both live ingest and
/// historical reload.
///
/// `local_agent` task events are left untouched — those are the real
/// subagent lifecycle, and whether/how to render them is handled
/// further down the pipeline.
pub(crate) fn is_claude_task_lifecycle(value: &Value) -> bool {
    let Some(subtype) = value.get("subtype").and_then(Value::as_str) else {
        return false;
    };
    matches!(
        subtype,
        "task_started" | "task_progress" | "task_notification"
    )
}

pub(crate) fn is_explicit_local_bash_task(value: &Value) -> bool {
    is_claude_task_lifecycle(value)
        && value.get("task_type").and_then(Value::as_str) == Some("local_bash")
}

pub(crate) fn is_suppressed_local_bash_task(value: &Value) -> bool {
    is_explicit_local_bash_task(value)
}

pub(crate) fn task_refs(value: &Value) -> impl Iterator<Item = &str> {
    ["task_id", "tool_use_id"]
        .into_iter()
        .filter_map(|key| value.get(key).and_then(Value::as_str))
}

pub(crate) fn is_local_bash_task_ref(
    value: &Value,
    known_refs: &std::collections::HashSet<String>,
) -> bool {
    is_claude_task_lifecycle(value) && task_refs(value).any(|id| known_refs.contains(id))
}

pub(crate) fn remember_task_refs(value: &Value, refs: &mut std::collections::HashSet<String>) {
    for id in task_refs(value) {
        refs.insert(id.to_string());
    }
}
