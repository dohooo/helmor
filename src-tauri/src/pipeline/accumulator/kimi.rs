//! Kimi (ACP) event handling — `kimi/`-namespaced events from the sidecar.
//!
//! The sidecar pre-flattens ACP `session/update`s into a small, clean event
//! set (see `sidecar/src/kimi-session-update.ts`):
//! - `agent_message_chunk` / `agent_thought_chunk` carry text DELTAS — append
//!   to the trailing text/reasoning part (a new part starts after any tool/plan).
//! - `tool_call` / `tool_call_update` are partial snapshots merged by
//!   `tool_call_id` (last-write-wins per field; an omitted field never clears).
//! - `plan` REPLACES the whole todo list.
//!
//! The turn finalizes on `kimi/turn_complete` (the sidecar's `session/prompt`
//! response). Output is a `kimi_message` rendered by `adapter/kimi_parts.rs`.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::super::types::{CollectedTurn, MessageRole};
use super::{PushOutcome, StreamAccumulator};

#[derive(Debug, Default)]
pub(super) struct KimiRunState {
    pub turn_id: Option<String>,
    /// Rendered parts in arrival order (text / reasoning / tool / plan).
    pub parts: Vec<Value>,
    /// tool_call_id → index into `parts` for merge-by-id.
    pub tool_index: HashMap<String, usize>,
    /// Index of the single plan part (ACP replaces it wholesale).
    pub plan_idx: Option<usize>,
}

pub(super) fn new_run_state() -> KimiRunState {
    KimiRunState::default()
}

// ── Event handlers ──────────────────────────────────────────────────────────

pub(super) fn handle_message_chunk(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    append_text(acc, "text", text_of(value))
}

pub(super) fn handle_thought_chunk(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    append_text(acc, "reasoning", text_of(value))
}

pub(super) fn handle_tool_call(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let Some(id) = value.get("tool_call_id").and_then(Value::as_str) else {
        return PushOutcome::NoOp;
    };
    if id.is_empty() {
        return PushOutcome::NoOp;
    }
    upsert_tool(acc, id, value);
    rebuild_collected(acc);
    PushOutcome::StreamingDelta
}

pub(super) fn handle_plan(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let entries = value.get("entries").cloned().unwrap_or_else(|| json!([]));
    let part = json!({ "type": "plan", "entries": entries });
    match acc.kimi_state.plan_idx {
        Some(idx) if idx < acc.kimi_state.parts.len() => acc.kimi_state.parts[idx] = part,
        _ => {
            let idx = acc.kimi_state.parts.len();
            acc.kimi_state.parts.push(part);
            acc.kimi_state.plan_idx = Some(idx);
        }
    }
    rebuild_collected(acc);
    PushOutcome::StreamingDelta
}

pub(super) fn handle_turn_complete(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let duration_ms = value.get("duration_ms").and_then(Value::as_f64);
    finalize(acc, duration_ms)
}

/// Drain the in-flight kimi message when no `turn_complete` will arrive
/// (abort, or the stream dying via `error`+`end`). Non-terminal tool parts
/// settle to `failed` so reloads don't render eternal spinners. Idempotent —
/// `parts` is empty after a normal `turn_complete`.
pub(super) fn flush_in_progress(acc: &mut StreamAccumulator) {
    for part in acc.kimi_state.parts.iter_mut() {
        if part.get("type").and_then(Value::as_str) == Some("tool")
            && !matches!(
                part.get("status").and_then(Value::as_str),
                Some("completed" | "failed")
            )
        {
            part["status"] = json!("failed");
        }
    }
    finalize(acc, None);
}

// ── Internals ───────────────────────────────────────────────────────────────

fn text_of(value: &Value) -> &str {
    value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Append a text/reasoning delta. Extends the trailing part when it is the
/// same kind, else starts a fresh part (so text→tool→text renders as two
/// text parts). Empty deltas are ignored.
fn append_text(acc: &mut StreamAccumulator, kind: &str, delta: &str) -> PushOutcome {
    if delta.is_empty() {
        return PushOutcome::NoOp;
    }
    let parts = &mut acc.kimi_state.parts;
    if let Some(last) = parts.last_mut() {
        if last.get("type").and_then(Value::as_str) == Some(kind) {
            let prev = last.get("text").and_then(Value::as_str).unwrap_or_default();
            last["text"] = json!(format!("{prev}{delta}"));
            rebuild_collected(acc);
            return PushOutcome::StreamingDelta;
        }
    }
    parts.push(json!({ "type": kind, "text": delta }));
    rebuild_collected(acc);
    PushOutcome::StreamingDelta
}

/// Merge a tool-call snapshot by id (last-write-wins per field; omitted fields
/// are preserved). Creates the part on first sight.
fn upsert_tool(acc: &mut StreamAccumulator, id: &str, value: &Value) {
    let idx = match acc.kimi_state.tool_index.get(id) {
        Some(&idx) if idx < acc.kimi_state.parts.len() => idx,
        _ => {
            let idx = acc.kimi_state.parts.len();
            acc.kimi_state
                .parts
                .push(json!({ "type": "tool", "tool_call_id": id }));
            acc.kimi_state.tool_index.insert(id.to_string(), idx);
            idx
        }
    };
    let slot = &mut acc.kimi_state.parts[idx];
    for field in [
        "title",
        "kind",
        "status",
        "raw_input",
        "output_text",
        "diffs",
    ] {
        if let Some(v) = value.get(field) {
            slot[field] = v.clone();
        }
    }
}

fn rebuild_collected(acc: &mut StreamAccumulator) {
    if acc.kimi_state.parts.is_empty() {
        return;
    }
    let turn_id = acc
        .kimi_state
        .turn_id
        .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
        .clone();
    let session_id_value: Value = acc
        .session_id
        .as_deref()
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    let message = json!({
        "type": "kimi_message",
        "session_id": session_id_value,
        "role": "assistant",
        "parts": acc.kimi_state.parts.clone(),
    });
    let raw = message.to_string();

    if let Some(pos) = acc.collected.iter().rposition(|m| m.id == turn_id) {
        acc.collected[pos].raw_json = raw;
        acc.collected[pos].parsed = Some(message);
        acc.kimi_partial_idx = Some(pos);
    } else {
        let idx = acc.collected.len();
        acc.collect_message(&raw, &message, MessageRole::Assistant, Some(&turn_id));
        acc.kimi_partial_idx = Some(idx);
    }
}

fn finalize(acc: &mut StreamAccumulator, duration_ms: Option<f64>) -> PushOutcome {
    if acc.kimi_state.parts.is_empty() {
        acc.kimi_state = KimiRunState::default();
        return PushOutcome::NoOp;
    }
    rebuild_collected(acc);
    acc.kimi_partial_idx = None;

    let turn_id = acc
        .kimi_state
        .turn_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let assistant_text: String = acc
        .kimi_state
        .parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    if !assistant_text.is_empty() {
        if !acc.assistant_text.is_empty() {
            acc.assistant_text.push('\n');
        }
        acc.assistant_text.push_str(&assistant_text);
    }

    if let Some(entry) = acc.collected.iter().rev().find(|m| m.id == turn_id) {
        acc.turns.push(CollectedTurn {
            id: turn_id,
            role: MessageRole::Assistant,
            content_json: entry.raw_json.clone(),
        });
    }

    // Synthesize a turn-result row so the adapter renders the duration footer,
    // matching Claude/Codex/OpenCode. ACP supplies no timing, so the sidecar
    // measures the turn and passes `duration_ms` on `kimi/turn_complete`; gating
    // on it keeps timing-free fixtures (and aborts) byte-identical.
    if let Some(duration) = duration_ms {
        if duration > 0.0 {
            let enriched = json!({ "type": "turn/completed", "duration_ms": duration });
            let enriched_str = enriched.to_string();
            let id = uuid::Uuid::new_v4().to_string();
            acc.result_id = Some(id.clone());
            acc.result_json = Some(enriched_str.clone());
            acc.collect_message(&enriched_str, &enriched, MessageRole::Assistant, Some(&id));
        }
    }

    // Reset per-turn state (fresh turn_id minted on the next event).
    acc.kimi_state = KimiRunState::default();
    PushOutcome::Finalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::accumulator::StreamAccumulator;
    use serde_json::json;

    fn chunk(kind: &str, text: &str) -> Value {
        json!({ "type": format!("kimi/{kind}"), "session_id": "ses_1", "text": text })
    }

    #[test]
    fn text_deltas_append_into_one_part_then_finalize() {
        let mut acc = StreamAccumulator::new("kimi", "");
        let out = acc.push_event(&chunk("agent_message_chunk", "Hel"), "");
        assert_eq!(out, PushOutcome::StreamingDelta);
        acc.push_event(&chunk("agent_message_chunk", "lo"), "");
        let done = acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        assert_eq!(done, PushOutcome::Finalized);
        let msgs = acc.collected();
        assert_eq!(msgs.len(), 1);
        let parsed = msgs[0].parsed.as_ref().unwrap();
        assert_eq!(parsed["type"], "kimi_message");
        assert_eq!(parsed["parts"][0]["type"], "text");
        assert_eq!(parsed["parts"][0]["text"], "Hello");
        assert_eq!(acc.session_id(), Some("ses_1"));
    }

    #[test]
    fn turn_complete_with_duration_synthesizes_footer() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(&chunk("agent_message_chunk", "Hi"), "");
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1", "duration_ms": 1500.0 }),
            "",
        );
        let msgs = acc.collected();
        let has_footer = msgs.iter().any(|m| {
            m.parsed
                .as_ref()
                .is_some_and(|p| p["type"] == "turn/completed" && p["duration_ms"] == 1500.0)
        });
        assert!(has_footer, "duration footer row should be synthesized");
        assert!(
            acc.take_result_id().is_some(),
            "result id wired for persistence"
        );
    }

    #[test]
    fn turn_complete_without_duration_has_no_footer() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(&chunk("agent_message_chunk", "Hi"), "");
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        let msgs = acc.collected();
        assert_eq!(msgs.len(), 1, "only the kimi_message, no footer");
        assert!(!msgs.iter().any(|m| m
            .parsed
            .as_ref()
            .is_some_and(|p| p["type"] == "turn/completed")));
    }

    #[test]
    fn thought_then_text_render_as_separate_parts() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(&chunk("agent_thought_chunk", "thinking"), "");
        acc.push_event(&chunk("agent_message_chunk", "answer"), "");
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        let parts = acc.collected()[0].parsed.as_ref().unwrap()["parts"].clone();
        assert_eq!(parts[0]["type"], "reasoning");
        assert_eq!(parts[0]["text"], "thinking");
        assert_eq!(parts[1]["type"], "text");
        assert_eq!(parts[1]["text"], "answer");
    }

    #[test]
    fn text_after_tool_starts_a_new_text_part() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(&chunk("agent_message_chunk", "before"), "");
        acc.push_event(
            &json!({ "type": "kimi/tool_call", "session_id": "ses_1",
                     "tool_call_id": "t1", "title": "Read", "kind": "read", "status": "completed" }),
            "",
        );
        acc.push_event(&chunk("agent_message_chunk", "after"), "");
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        let parts = acc.collected()[0].parsed.as_ref().unwrap()["parts"].clone();
        let kinds: Vec<&str> = parts
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["text", "tool", "text"]);
        assert_eq!(parts[0]["text"], "before");
        assert_eq!(parts[2]["text"], "after");
    }

    #[test]
    fn tool_call_update_merges_by_id_without_clearing() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(
            &json!({ "type": "kimi/tool_call", "session_id": "ses_1",
                     "tool_call_id": "t1", "title": "Run", "kind": "execute", "status": "pending",
                     "raw_input": { "command": "ls" } }),
            "",
        );
        // Update carries only status + output; title/kind/raw_input must persist.
        acc.push_event(
            &json!({ "type": "kimi/tool_call_update", "session_id": "ses_1",
                     "tool_call_id": "t1", "status": "completed", "output_text": "a.txt" }),
            "",
        );
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        let tool = &acc.collected()[0].parsed.as_ref().unwrap()["parts"][0];
        assert_eq!(tool["type"], "tool");
        assert_eq!(tool["tool_call_id"], "t1");
        assert_eq!(tool["title"], "Run");
        assert_eq!(tool["kind"], "execute");
        assert_eq!(tool["status"], "completed");
        assert_eq!(tool["raw_input"]["command"], "ls");
        assert_eq!(tool["output_text"], "a.txt");
    }

    #[test]
    fn plan_replaces_whole_list() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(
            &json!({ "type": "kimi/plan", "session_id": "ses_1",
                     "entries": [{ "content": "a", "priority": "high", "status": "pending" }] }),
            "",
        );
        acc.push_event(
            &json!({ "type": "kimi/plan", "session_id": "ses_1",
                     "entries": [
                        { "content": "a", "priority": "high", "status": "completed" },
                        { "content": "b", "priority": "low", "status": "pending" }] }),
            "",
        );
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        let parts = acc.collected()[0].parsed.as_ref().unwrap()["parts"].clone();
        assert_eq!(parts.as_array().unwrap().len(), 1);
        assert_eq!(parts[0]["type"], "plan");
        let entries = parts[0]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["status"], "completed");
    }

    #[test]
    fn tool_call_update_before_tool_call_upserts_one_part() {
        let mut acc = StreamAccumulator::new("kimi", "");
        // Out-of-order: the update arrives first and creates the part …
        acc.push_event(
            &json!({ "type": "kimi/tool_call_update", "session_id": "ses_1",
                     "tool_call_id": "t1", "status": "in_progress" }),
            "",
        );
        // … and the late tool_call merges into the same slot, no duplicate.
        acc.push_event(
            &json!({ "type": "kimi/tool_call", "session_id": "ses_1",
                     "tool_call_id": "t1", "title": "Run", "kind": "execute",
                     "status": "in_progress", "raw_input": { "command": "ls" } }),
            "",
        );
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        let parts = acc.collected()[0].parsed.as_ref().unwrap()["parts"].clone();
        assert_eq!(parts.as_array().unwrap().len(), 1);
        assert_eq!(parts[0]["tool_call_id"], "t1");
        assert_eq!(parts[0]["title"], "Run");
        assert_eq!(parts[0]["raw_input"]["command"], "ls");
    }

    #[test]
    fn flush_finalizes_in_progress_turn_on_abort() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(&chunk("agent_message_chunk", "partial"), "");
        assert!(acc.has_active_partial());
        acc.flush_kimi_in_progress();
        assert_eq!(acc.turns_len(), 1);
        assert!(!acc.has_active_partial());
    }

    #[test]
    fn flush_settles_non_terminal_tools_to_failed() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(
            &json!({ "type": "kimi/tool_call", "session_id": "ses_1",
                     "tool_call_id": "t1", "title": "Read", "kind": "read", "status": "completed" }),
            "",
        );
        acc.push_event(
            &json!({ "type": "kimi/tool_call", "session_id": "ses_1",
                     "tool_call_id": "t2", "title": "Run", "kind": "execute", "status": "in_progress" }),
            "",
        );
        acc.flush_kimi_in_progress();
        assert_eq!(acc.turns_len(), 1);
        let turn: Value = serde_json::from_str(&acc.turn_at(0).content_json).unwrap();
        // Terminal status untouched; in-flight one settles so reloads
        // don't render an eternal spinner.
        assert_eq!(turn["parts"][0]["status"], "completed");
        assert_eq!(turn["parts"][1]["status"], "failed");
    }

    #[test]
    fn flush_after_turn_complete_is_a_noop() {
        let mut acc = StreamAccumulator::new("kimi", "");
        acc.push_event(&chunk("agent_message_chunk", "done"), "");
        acc.push_event(
            &json!({ "type": "kimi/turn_complete", "session_id": "ses_1" }),
            "",
        );
        assert_eq!(acc.turns_len(), 1);
        // The error/end termination path flushes unconditionally — it must
        // not duplicate an already-finalized turn.
        acc.flush_kimi_in_progress();
        assert_eq!(acc.turns_len(), 1);
    }

    #[test]
    fn session_init_is_a_noop() {
        let mut acc = StreamAccumulator::new("kimi", "");
        let out = acc.push_event(
            &json!({ "type": "kimi/session_init", "session_id": "ses_1", "model": "kimi-for-coding" }),
            "",
        );
        assert_eq!(out, PushOutcome::NoOp);
        assert!(acc.collected().is_empty());
        // session_id is still lifted by push_event for provider-session tracking.
        assert_eq!(acc.session_id(), Some("ses_1"));
    }
}
