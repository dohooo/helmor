//! Events emitted by the voice planner as it runs a turn.
//!
//! Each variant lands on the frontend through a `Channel<PlannerEvent>`
//! that `start_planner_turn` accepts. The frontend dispatcher turns each
//! `Say` / `Final` into an out-of-band `response.create` so rt voices it.
//! `Status` is for the diag stream only — never spoken.

use serde::{Deserialize, Serialize};

// `Deserialize` is here so the standalone `planner_probe` binary can
// parse events off a Tauri `Channel` callback for self-validation; the
// production path only ever serializes (Rust → frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
// Two separate `rename_all` directives — easy to think they're the
// same knob, but they aren't:
//   * `rename_all = "camelCase"` (on the enum) lowercases variant
//     tags: `Say` → `say`.
//   * `rename_all_fields = "camelCase"` (on the enum) renames the
//     *fields inside each variant*: `turn_id` → `turnId`.
// Without `rename_all_fields`, the wire form was
// `{"kind":"say","turn_id":"…","text":"…"}` while the frontend type
// declares `turnId` — every event then failed the dispatcher's stale-
// turn guard and was silently dropped, leaving rt with only its own
// "好的" ack to voice. Keep BOTH directives; the regression test in
// the `tests` module below pins the wire format.
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlannerEvent {
    /// Planner has been accepted; the SSE stream is open. Frontend uses
    /// this to know the turn is live (and to flush any "still spinning
    /// up" UI state).
    Started { turn_id: String },
    /// Interim user-facing line. The dispatcher should voice this through
    /// rt's `response.create` with a strict-text instruction. Tone is the
    /// planner's hint to the dispatcher about whether this is filler
    /// ("hmm") or a real finding ("found three workspaces") — kept for
    /// later UX use, the dispatcher currently treats them identically.
    Say { turn_id: String, text: String },
    /// Planner's final answer for the turn. The dispatcher voices this
    /// exactly like a `Say` but then closes the queue and returns
    /// control to organic rt behavior.
    Final { turn_id: String, text: String },
    /// Hint about progress milestones — entered "reasoning", started
    /// calling a real tool, etc. Pure diag, never spoken.
    Status { turn_id: String, note: String },
    /// Planner crashed / API rejected / timeout. The dispatcher should
    /// either speak a short error ("something went wrong, try again")
    /// or stay silent depending on whether anything was said yet.
    Error { turn_id: String, message: String },
    /// Planner stream closed cleanly. Always the last event for a
    /// successful turn — even if `Final` already fired. Useful for the
    /// frontend to know the channel is going away.
    Done { turn_id: String },
    /// A Helmor tool call started. Diag only — the frontend can use
    /// this to surface progress UI ("listing workspaces…") if needed,
    /// but we don't VOICE it; cadence comes from the planner's own
    /// `say` calls.
    ToolCallStarted {
        turn_id: String,
        call_id: String,
        name: String,
        args_preview: String,
    },
    /// A Helmor tool call completed. `ok=false` means the tool errored
    /// — frontend may want to surface this if the planner stays silent
    /// about it. `duration_ms` is wall-clock spent in the tool.
    ToolCallCompleted {
        turn_id: String,
        call_id: String,
        name: String,
        ok: bool,
        duration_ms: u64,
        result_preview: String,
    },
    /// React Query cache invalidation hint — fires whenever a planner-
    /// invoked tool mutates state the GUI is showing. `kinds` mirrors
    /// `VoiceToolMutationKind` strings (e.g. "workspaces", "sessions").
    Invalidate { turn_id: String, kinds: Vec<String> },
    /// UI navigation hint — fires when a tool result resolves a target
    /// workspace the user would expect to land on (e.g. after
    /// `create_workspace_and_send`). Frontend should call the same
    /// `onNavigateToWorkspace` callback rt used.
    NavigateToWorkspace {
        turn_id: String,
        workspace_id: String,
    },
    /// Worker invoked the `end_session` tool. Phase 2.1 moves this
    /// flow-control signal from Reception to Worker so the planner
    /// can decide WHEN to end (after voicing a goodbye via `final`).
    /// Dispatcher should schedule WebRTC teardown AFTER the say/final
    /// queue drains — matches the existing rt-side "let the audio
    /// buffer flush" delay.
    EndSession { turn_id: String },
    /// Worker invoked `capture_screen`. The actual image bytes ride
    /// this event so the frontend dispatcher can inject them as an
    /// `input_image` content item into Reception's WebRTC conversation
    /// (the only place where a multimodal model can see them). The
    /// Worker itself receives a text-only summary in its
    /// `function_call_output` — putting hundreds of KB of base64 into
    /// the planner's context would blow the token budget without
    /// helping (gpt-5.4-mini is text-only).
    CaptureImage {
        turn_id: String,
        width: u32,
        height: u32,
        data_url: String,
        caption: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin the wire format. The frontend dispatcher matches by
    /// `kind` and reads `turnId` to guard against stale events from a
    /// previously aborted turn — if either field name regresses, the
    /// dispatcher silently drops every planner event.
    #[test]
    fn planner_event_serializes_as_camelcase_with_kind_tag() {
        let say = PlannerEvent::Say {
            turn_id: "turn-x".into(),
            text: "hi".into(),
        };
        let json = serde_json::to_string(&say).unwrap();
        assert!(
            json.contains("\"kind\":\"say\""),
            "expected kind tag, got: {json}"
        );
        assert!(
            json.contains("\"turnId\":\"turn-x\""),
            "expected camelCase turnId, got: {json}"
        );
        assert!(
            json.contains("\"text\":\"hi\""),
            "expected text, got: {json}"
        );
    }
}
