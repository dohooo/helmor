//! User-controlled noise filter for SDK events.
//!
//! Single source of truth — three call sites consult this module:
//! - `accumulator::push_event` reads `SUPPRESSED_EVENT_TYPES` and drops
//!   matching top-level events before any handler runs (NoOp).
//! - `accumulator::handle_claude_system` reads `SUPPRESSED_SYSTEM_SUBTYPES`
//!   on live ingest.
//! - `adapter::convert_system_msg` reads `SUPPRESSED_SYSTEM_SUBTYPES`
//!   on historical reload, so old persisted noise rows from earlier
//!   code versions render with the same rules as new turns.
//!
//! Comment out a line to start surfacing that event again.

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
    // "Session initialized — claude-opus-4-6" is redundant.
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
    // Dead arm — `task_completed` is not in `@anthropic-ai/claude-agent-sdk`
    // v0.2.92's `.d.ts`. The real lifecycle uses `task_notification`.
    // Listed here defensively in case the SDK ever revives it.
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
