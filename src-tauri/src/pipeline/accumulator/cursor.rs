//! Cursor event handling — `cursor/`-namespaced events from the sidecar.
//!
//! Events:
//!   - `agent_init` (synthetic, carries session_id) — NoOp here
//!   - `status` RUNNING/FINISHED — turn boundary / finalize trigger
//!   - `thinking` (delta + duration close), `assistant` (text delta)
//!   - `tool_call_start` / `tool_call_end`
//!
//! Output: synthesized Claude-format messages so the adapter is shared.
//! Cancel goes through the same FINISHED path; manager-level abort is
//! signalled via the typed `aborted` control event in `mod.rs`.

use std::collections::HashMap;

use serde_json::{json, Value};
use uuid::Uuid;

use super::super::types::{CollectedTurn, MessageRole};
use super::{now_ms, PushOutcome, StreamAccumulator};

#[derive(Debug, Default)]
pub(super) struct CursorRunState {
    pub run_id: Option<String>,
    pub assistant_text: String,
    pub thinking_text: String,
    pub thinking_duration_ms: Option<u64>,
    /// Insertion-ordered tool calls. Each → one tool_use + tool_result.
    pub tools: Vec<CursorToolCall>,
    /// O(1) lookup `call_id` → index into `tools`.
    pub tool_index: HashMap<String, usize>,
    pub started_at: Option<f64>,
}

#[derive(Debug, Default, Clone)]
pub(super) struct CursorToolCall {
    pub call_id: String,
    pub name: String,
    pub args: Value,
    pub result: Option<Value>,
    pub is_error: bool,
}

pub(super) fn new_run_state() -> CursorRunState {
    CursorRunState::default()
}

pub(super) fn handle_status(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match status {
        "RUNNING" => {
            acc.cursor_state = new_run_state();
            acc.cursor_state.run_id = value
                .get("run_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            acc.cursor_state.started_at = Some(now_ms());
            acc.fallback_text.clear();
            acc.fallback_thinking.clear();
            PushOutcome::NoOp
        }
        "FINISHED" => finalize(acc),
        _ => PushOutcome::NoOp,
    }
}

pub(super) fn handle_thinking(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let mut changed = false;
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            acc.cursor_state.thinking_text.push_str(text);
            acc.saw_thinking_delta = true;
            changed = true;
        }
    }
    if let Some(ms) = value.get("thinking_duration_ms").and_then(Value::as_u64) {
        acc.cursor_state.thinking_duration_ms = Some(ms);
        changed = true;
    }
    if !changed {
        return PushOutcome::NoOp;
    }
    // Materialize thinking as its own leading message so it stays ahead of
    // any tools that arrive after it. Streams via the provider partial;
    // `fallback_thinking` is intentionally left untouched.
    materialize_cursor_thinking(acc, false);
    PushOutcome::StreamingDelta
}

pub(super) fn handle_assistant_delta(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let text = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
        });
    if let Some(text) = text {
        if !text.is_empty() {
            acc.cursor_state.assistant_text.push_str(text);
            acc.fallback_text.push_str(text);
            acc.saw_text_delta = true;
        }
    }
    PushOutcome::StreamingDelta
}

pub(super) fn handle_tool_call_start(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let call_id = value
        .get("call_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return PushOutcome::NoOp;
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let args = value.get("args").cloned().unwrap_or(json!({}));

    let idx = if let Some(&idx) = acc.cursor_state.tool_index.get(&call_id) {
        // Mid-stream arg refinement — replace existing entry's args.
        if let Some(entry) = acc.cursor_state.tools.get_mut(idx) {
            entry.name = name;
            entry.args = args;
        }
        idx
    } else {
        let idx = acc.cursor_state.tools.len();
        acc.cursor_state.tools.push(CursorToolCall {
            call_id: call_id.clone(),
            name,
            args,
            result: None,
            is_error: false,
        });
        acc.cursor_state.tool_index.insert(call_id, idx);
        idx
    };
    // Materialize the running tool_use into `collected[]` immediately so it
    // renders live (Finalized → full render). Persist only on tool_call_end.
    let tool = acc.cursor_state.tools[idx].clone();
    emit_cursor_tool(acc, &tool, false);
    PushOutcome::Finalized
}

pub(super) fn handle_tool_call_end(acc: &mut StreamAccumulator, value: &Value) -> PushOutcome {
    let call_id = match value.get("call_id").and_then(Value::as_str) {
        Some(id) => id,
        None => return PushOutcome::NoOp,
    };
    let result = value.get("result").cloned();
    let is_error = value
        .get("result")
        .and_then(|r| r.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|status| status != "success");

    let idx = match acc.cursor_state.tool_index.get(call_id) {
        Some(&idx) => idx,
        // No matching tool_call_start — ignore.
        None => return PushOutcome::NoOp,
    };
    if let Some(entry) = acc.cursor_state.tools.get_mut(idx) {
        entry.result = result;
        entry.is_error = is_error;
    }
    // Re-upsert the now-complete tool (result-derived input + tool_result
    // message) and persist its turns. Finalized → full render so the card
    // flips from running to done live.
    let tool = acc.cursor_state.tools[idx].clone();
    emit_cursor_tool(acc, &tool, true);
    PushOutcome::Finalized
}

/// Drain in-flight cursor state on abort (no `status FINISHED` will
/// arrive). Same emission as the happy path — pending tools render as
/// tool_use without tool_result, matching reality.
pub(super) fn flush_in_progress(acc: &mut StreamAccumulator) {
    finalize(acc);
}

/// Build the `{type:"assistant", ...}` envelope cursor messages share. Each
/// per-tool / thinking / text message uses it so the shared adapter sees a
/// uniform Claude-shaped assistant.
fn cursor_assistant_msg(acc: &StreamAccumulator, msg_id: &str, content: Vec<Value>) -> Value {
    let session_id_value: Value = acc
        .session_id
        .as_deref()
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    json!({
        "type": "assistant",
        "session_id": session_id_value,
        "message": {
            "id": msg_id,
            "role": "assistant",
            "model": acc.resolved_model,
            "content": content,
        },
    })
}

/// Materialize one tool call into `collected[]` as a Claude-shaped
/// `assistant{tool_use}` (plus a `user{tool_result}` once the result is in),
/// keyed by stable ids so successive upserts (running → done) replace in
/// place and render live. Mirrors codex's `handle_command_execution`.
/// `persist` pushes the matching `CollectedTurn`(s) for reload — done on
/// completion (`tool_call_end`) and on the abort flush, never on `start`.
fn emit_cursor_tool(acc: &mut StreamAccumulator, tool: &CursorToolCall, persist: bool) {
    let (mapped_name, mapped_args) = translate_cursor_tool(tool);
    let mut tool_use = json!({
        "type": "tool_use",
        "id": tool.call_id,
        "name": mapped_name,
        "input": mapped_args,
    });
    if tool.result.is_none() {
        // Spinner during streaming; abort flips this to "error" via
        // `mark_pending_tools_aborted` (matches codex's contract).
        tool_use["__streaming_status"] = json!("running");
    }
    let asst_id = format!("cursor-tool-asst:{}", tool.call_id);
    let asst = cursor_assistant_msg(acc, &asst_id, vec![tool_use]);
    let asst_str = asst.to_string();
    acc.collect_or_replace(
        &asst_str,
        &asst,
        MessageRole::Assistant,
        Some(asst_id.clone()),
    );
    if persist {
        acc.turns.push(CollectedTurn {
            id: asst_id,
            role: MessageRole::Assistant,
            content_json: asst_str,
        });
    }

    let Some(result) = &tool.result else {
        return;
    };
    let result_text = format_tool_result(result);
    let is_error = tool.is_error;
    let user_id = format!("cursor-tool-user:{}", tool.call_id);
    let user_msg = json!({
        "type": "user",
        "session_id": acc
            .session_id
            .as_deref()
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool.call_id,
                "content": result_text,
                "is_error": is_error,
            }],
        },
    });
    let user_str = user_msg.to_string();
    acc.collect_or_replace(
        &user_str,
        &user_msg,
        MessageRole::User,
        Some(user_id.clone()),
    );
    if persist {
        acc.turns.push(CollectedTurn {
            id: user_id,
            role: MessageRole::User,
            content_json: user_str,
        });
    }
}

/// Materialize the accumulated thinking into its own leading
/// `assistant{thinking}` message, keyed by a stable id so it stays ahead of
/// any tools. `persist` pushes its turn (done at finalize).
fn materialize_cursor_thinking(acc: &mut StreamAccumulator, persist: bool) {
    let thinking = acc.cursor_state.thinking_text.clone();
    if thinking.is_empty() {
        return;
    }
    let duration = acc.cursor_state.thinking_duration_ms;
    let (turn_id, _) = acc.get_or_create_turn_identity();
    let think_id = format!("cursor-think:{turn_id}");
    let mut block = json!({
        "type": "thinking",
        "thinking": thinking,
        "signature": "",
    });
    if let Some(ms) = duration {
        block["__duration_ms"] = json!(ms);
    }
    let msg = cursor_assistant_msg(acc, &think_id, vec![block]);
    let msg_str = msg.to_string();
    acc.collect_or_replace(
        &msg_str,
        &msg,
        MessageRole::Assistant,
        Some(think_id.clone()),
    );
    if persist {
        acc.turns.push(CollectedTurn {
            id: think_id,
            role: MessageRole::Assistant,
            content_json: msg_str,
        });
    }
}

/// Finalize a cursor turn on `status FINISHED`. Tools were already
/// materialized live (per `tool_call_start`/`end`); here we persist any tool
/// left running (abort flush), push the leading thinking + trailing text
/// turns, roll persistence fields, and emit the `turn/completed` footer.
fn finalize(acc: &mut StreamAccumulator) -> PushOutcome {
    let has_text = !acc.cursor_state.assistant_text.is_empty();
    let has_thinking = !acc.cursor_state.thinking_text.is_empty();
    let has_tools = !acc.cursor_state.tools.is_empty();
    if !has_text && !has_thinking && !has_tools {
        acc.fallback_text.clear();
        acc.fallback_thinking.clear();
        acc.cursor_state = new_run_state();
        return PushOutcome::NoOp;
    }

    // Persist any tool that started but never completed (abort path). On a
    // clean FINISHED every tool already persisted at its `tool_call_end`, so
    // `result.is_some()` and this re-emits nothing.
    let tools = std::mem::take(&mut acc.cursor_state.tools);
    for tool in &tools {
        if tool.result.is_none() {
            emit_cursor_tool(acc, tool, true);
        }
    }

    // Thinking leads (already streamed in place); push its turn now.
    if has_thinking {
        materialize_cursor_thinking(acc, true);
    }

    // Trailing assistant text (streamed via the fallback partial).
    if has_text {
        let text = acc.cursor_state.assistant_text.clone();
        let (turn_id, _) = acc.get_or_create_turn_identity();
        let msg = cursor_assistant_msg(acc, &turn_id, vec![json!({"type": "text", "text": text})]);
        let msg_str = msg.to_string();
        acc.collect_or_replace(
            &msg_str,
            &msg,
            MessageRole::Assistant,
            Some(turn_id.clone()),
        );
        acc.turns.push(CollectedTurn {
            id: turn_id,
            role: MessageRole::Assistant,
            content_json: msg_str,
        });
    }

    // Roll into persistence fields for parsed_output().
    if has_text {
        let text = acc.cursor_state.assistant_text.clone();
        if !acc.assistant_text.is_empty() {
            acc.assistant_text.push('\n');
        }
        acc.assistant_text.push_str(&text);
    }
    if has_thinking {
        let thinking = acc.cursor_state.thinking_text.clone();
        if !acc.thinking_text.is_empty() {
            acc.thinking_text.push('\n');
        }
        acc.thinking_text.push_str(&thinking);
    }

    acc.fallback_text.clear();
    acc.fallback_thinking.clear();

    // Synthesize a turn/completed row with duration so the adapter renders
    // the "Ns • about X ago" footer, matching Claude/Codex behavior.
    if let Some(started) = acc.cursor_state.started_at {
        let duration = now_ms() - started;
        if duration > 0.0 {
            let enriched = json!({ "type": "turn/completed", "duration_ms": duration });
            let enriched_str = serde_json::to_string(&enriched).unwrap_or_default();
            let id = Uuid::new_v4().to_string();
            acc.result_id = Some(id.clone());
            acc.result_json = Some(enriched_str.clone());
            acc.collect_message(&enriched_str, &enriched, MessageRole::Assistant, Some(&id));
        }
    }

    acc.cursor_state = new_run_state();
    PushOutcome::Finalized
}

/// Map a Cursor tool call onto a Claude-shaped `(tool_name, input)` so
/// the frontend renderer (`getToolInfo` /
/// `tool-call.tsx::AssistantToolCall` in
/// `src/features/panel/message-components/`) picks the right icon +
/// detail line. Without this translation cursor tool calls fall through
/// to a bare `{ action: name }` and render as just the tool name.
///
/// Real cursor wire shapes (captured via the SDK probe under
/// `tests/fixtures/cursor-tools/`):
/// - `shell`: args `{command, workingDirectory, timeout}`,
///   result `{value:{exitCode, stdout, stderr, executionTime}}`
/// - `glob`: args `{globPattern, targetDirectory}`
/// - `grep`: args `{pattern, path, offset}` (sometimes more)
/// - `read`: args `{path}`, result `{value:{content, totalLines, fileSize}}`
/// - `edit`: args `{path}` only — the diff lives in the result
///   `{value:{linesAdded, linesRemoved, diffString}}`. Cursor uses
///   the same `edit` tool for both new files AND in-place edits;
///   there is no separate `write`.
/// - `apply_patch`: another cursor tool that already emits the
///   claude-compatible shape `{changes:[{path, diff, kind}]}` —
///   passes through unchanged.
///
/// Edit handling is special: we synthesize a Claude-style `apply_patch`
/// (the same shape claude/codex use for unified-diff edits) so the
/// frontend's existing `apply_patch` branch renders the file diff with
/// linecounts + expandable diff. Falls back to a bare `Edit { file_path }`
/// when the result hasn't arrived yet (mid-stream).
fn translate_cursor_tool(tool: &CursorToolCall) -> (String, Value) {
    let args = &tool.args;
    let args_obj = args.as_object();

    // Helper: rename the first present key on `src` into `out` under `out_key`.
    fn rename(
        out: &mut serde_json::Map<String, Value>,
        src: &serde_json::Map<String, Value>,
        out_key: &str,
        keys: &[&str],
    ) {
        for k in keys {
            if let Some(v) = src.get(*k) {
                out.insert(out_key.to_string(), v.clone());
                return;
            }
        }
    }

    match tool.name.as_str() {
        "shell" => {
            let mut out = serde_json::Map::new();
            if let Some(src) = args_obj {
                rename(&mut out, src, "command", &["command"]);
                // Cursor's `workingDirectory` has no claude analogue; fold
                // it into `description` so the renderer's primary line
                // surfaces it.
                if let Some(wd) = src.get("workingDirectory").and_then(Value::as_str) {
                    if let Some(cmd) = src.get("command").and_then(Value::as_str) {
                        out.insert("description".to_string(), json!(format!("{wd}: {cmd}")));
                    } else {
                        out.insert("description".to_string(), json!(format!("cwd: {wd}")));
                    }
                }
                if let Some(t) = src.get("timeout") {
                    out.insert("timeout".to_string(), t.clone());
                }
            }
            ("Bash".to_string(), Value::Object(out))
        }
        "glob" => {
            let mut out = serde_json::Map::new();
            if let Some(src) = args_obj {
                rename(&mut out, src, "pattern", &["globPattern", "pattern"]);
                rename(&mut out, src, "path", &["targetDirectory", "path"]);
            }
            ("Glob".to_string(), Value::Object(out))
        }
        "grep" => {
            let mut out = serde_json::Map::new();
            if let Some(src) = args_obj {
                rename(&mut out, src, "pattern", &["pattern"]);
                rename(&mut out, src, "path", &["path"]);
                rename(&mut out, src, "glob", &["glob"]);
                rename(&mut out, src, "head_limit", &["headLimit", "head_limit"]);
                rename(&mut out, src, "output_mode", &["outputMode", "output_mode"]);
                rename(&mut out, src, "offset", &["offset"]);
                rename(
                    &mut out,
                    src,
                    "case_insensitive",
                    &["caseInsensitive", "case_insensitive"],
                );
                rename(&mut out, src, "multiline", &["multiline"]);
            }
            ("Grep".to_string(), Value::Object(out))
        }
        "read" => {
            let mut out = serde_json::Map::new();
            if let Some(src) = args_obj {
                rename(
                    &mut out,
                    src,
                    "file_path",
                    &["path", "filePath", "file_path", "targetFile"],
                );
                rename(&mut out, src, "limit", &["limit"]);
                rename(&mut out, src, "offset", &["offset"]);
            }
            ("Read".to_string(), Value::Object(out))
        }
        "edit" | "write" => {
            // Args carry only `{path}`. The diff lives in the result.
            // When the result has arrived, synthesize `apply_patch` so
            // the frontend's existing diff renderer picks it up. While
            // the tool is still mid-stream (no result yet) fall back to
            // `Edit { file_path }` — the renderer at least shows the
            // filename and pencil icon.
            let path = args_obj
                .and_then(|src| {
                    for k in ["path", "filePath", "file_path", "targetFile"] {
                        if let Some(v) = src.get(k).and_then(Value::as_str) {
                            return Some(v.to_string());
                        }
                    }
                    None
                })
                .unwrap_or_default();

            if let Some(diff_string) = tool
                .result
                .as_ref()
                .and_then(|r| r.get("value"))
                .and_then(|v| v.get("diffString"))
                .and_then(Value::as_str)
            {
                let lines_removed = tool
                    .result
                    .as_ref()
                    .and_then(|r| r.get("value"))
                    .and_then(|v| v.get("linesRemoved"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                // `linesRemoved == 0` matches cursor's "new file" diff
                // (`--- /dev/null`). Anything else is an in-place
                // update; we pass `move_path: null` so the shape lines
                // up byte-for-byte with cursor's native `apply_patch`
                // payloads on the `update` branch.
                let kind = if lines_removed == 0 {
                    json!({ "type": "add" })
                } else {
                    json!({ "type": "update", "move_path": Value::Null })
                };
                let synthesized = json!({
                    "changes": [{
                        "path": path,
                        "diff": diff_string,
                        "kind": kind,
                    }],
                });
                return ("apply_patch".to_string(), synthesized);
            }

            // Mid-stream fallback — only file_path is meaningful.
            let mut out = serde_json::Map::new();
            if !path.is_empty() {
                out.insert("file_path".to_string(), json!(path));
            }
            ("Edit".to_string(), Value::Object(out))
        }
        "task" => {
            // Cursor's subagent invocation. Wire shape:
            //   args: {agentId, subagentType, description, prompt, model, mode}
            //   result: subagent's final output (string or JSON), only on
            //           the `tool_call_end` event.
            //
            // We pass the args through unchanged but rename the tool to
            // `cursor_task` — a Helmor-internal namespace so the frontend
            // dispatcher (`assistant-message.tsx`) can route it to the
            // dedicated `<CursorSubagentToolCall>` renderer without
            // colliding with claude's `Task`/`Agent` (TitleCase, different
            // arg shape) or codex's `subagent_*` family.
            //
            // The renderer reads agentId for stable color identity (same
            // helper codex uses), surfaces model/mode as small chips,
            // shows description as the secondary line, and exposes the
            // full prompt + result via expand. See the component for the
            // full visual contract.
            ("cursor_task".to_string(), args.clone())
        }
        // `apply_patch` already matches claude's expected shape — pass
        // through. Anything unrecognized (MCP tools `mcp__server__name`
        // included) likewise passes through; the renderer has its own
        // branches for those.
        _ => (tool.name.clone(), args.clone()),
    }
}

/// Cursor's `result` envelope is `{status, value: {exitCode, stdout, …}}`
/// for shell, or arbitrary JSON for other tools. Render shell as the raw
/// stdout (most useful for the user); fall back to a JSON dump.
fn format_tool_result(result: &Value) -> String {
    if let Some(value) = result.get("value") {
        if let Some(stdout) = value.get("stdout").and_then(Value::as_str) {
            let stderr = value
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if stderr.is_empty() {
                return stdout.to_string();
            }
            return format!("{stdout}\n[stderr]\n{stderr}");
        }
    }
    serde_json::to_string_pretty(result).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    fn push(acc: &mut StreamAccumulator, s: &str) -> PushOutcome {
        let v = ev(s);
        acc.push_event(&v, &v.to_string())
    }

    #[test]
    fn tool_call_start_materializes_running_tool_use_live() {
        let mut acc = StreamAccumulator::new("cursor", "composer-2");
        push(
            &mut acc,
            r#"{"type":"cursor/status","status":"RUNNING","run_id":"r1"}"#,
        );
        let outcome = push(
            &mut acc,
            r#"{"type":"cursor/tool_call_start","call_id":"t1","name":"shell","status":"running","args":{"command":"ls"}}"#,
        );
        // Finalized → full render so the tool appears mid-stream (not batched).
        assert!(matches!(outcome, PushOutcome::Finalized));
        let collected = acc.collected();
        assert_eq!(collected.len(), 1);
        let block = &collected[0].parsed.as_ref().unwrap()["message"]["content"][0];
        assert_eq!(block["type"], "tool_use");
        assert_eq!(block["name"], "Bash");
        assert_eq!(block["__streaming_status"], "running");
        // Not persisted until tool_call_end.
        assert_eq!(acc.turns_len(), 0);
    }

    #[test]
    fn tool_call_end_adds_result_clears_running_and_persists() {
        let mut acc = StreamAccumulator::new("cursor", "composer-2");
        push(
            &mut acc,
            r#"{"type":"cursor/status","status":"RUNNING","run_id":"r1"}"#,
        );
        push(
            &mut acc,
            r#"{"type":"cursor/tool_call_start","call_id":"t1","name":"shell","status":"running","args":{"command":"ls"}}"#,
        );
        let outcome = push(
            &mut acc,
            r#"{"type":"cursor/tool_call_end","call_id":"t1","name":"shell","status":"completed","args":{"command":"ls"},"result":{"status":"success","value":{"stdout":"file\n","stderr":""}}}"#,
        );
        assert!(matches!(outcome, PushOutcome::Finalized));
        let collected = acc.collected();
        // assistant(tool_use) + user(tool_result).
        assert_eq!(collected.len(), 2);
        let asst = &collected[0].parsed.as_ref().unwrap()["message"]["content"][0];
        assert_eq!(asst["type"], "tool_use");
        assert!(
            asst.get("__streaming_status").is_none(),
            "done tool drops running"
        );
        let result = &collected[1].parsed.as_ref().unwrap()["message"]["content"][0];
        assert_eq!(result["type"], "tool_result");
        assert_eq!(result["tool_use_id"], "t1");
        assert!(result["content"].as_str().unwrap().contains("file"));
        // Both persisted as turns on completion.
        assert_eq!(acc.turns_len(), 2);
    }

    #[test]
    fn finalize_splits_text_into_its_own_trailing_turn() {
        let mut acc = StreamAccumulator::new("cursor", "composer-2");
        for s in [
            r#"{"type":"cursor/status","status":"RUNNING","run_id":"r1"}"#,
            r#"{"type":"cursor/tool_call_start","call_id":"t1","name":"shell","status":"running","args":{"command":"ls"}}"#,
            r#"{"type":"cursor/tool_call_end","call_id":"t1","name":"shell","status":"completed","args":{"command":"ls"},"result":{"status":"success","value":{"stdout":"x\n"}}}"#,
            r#"{"type":"cursor/assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}"#,
            r#"{"type":"cursor/status","status":"FINISHED","run_id":"r1"}"#,
        ] {
            push(&mut acc, s);
        }
        // Per-item: asst(tool_use), user(tool_result), asst(text). Footer is a
        // collected message, not a turn.
        assert_eq!(acc.turns_len(), 3);
        assert_eq!(acc.turn_at(2).role, MessageRole::Assistant);
        assert!(acc.turn_at(2).content_json.contains("done"));
    }

    #[test]
    fn finalize_thinking_leads_text_as_separate_turns() {
        let mut acc = StreamAccumulator::new("cursor", "composer-2");
        for s in [
            r#"{"type":"cursor/status","status":"RUNNING","run_id":"r1"}"#,
            r#"{"type":"cursor/thinking","text":"hmm"}"#,
            r#"{"type":"cursor/assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}"#,
            r#"{"type":"cursor/status","status":"FINISHED","run_id":"r1"}"#,
        ] {
            push(&mut acc, s);
        }
        // Thinking turn first, text turn second.
        assert_eq!(acc.turns_len(), 2);
        assert!(acc.turn_at(0).content_json.contains("thinking"));
        assert!(acc.turn_at(1).content_json.contains("answer"));
    }

    /// Build a `CursorToolCall` from one of the captured wire-format
    /// fixtures under `tests/fixtures/cursor-tools/`. Each fixture is a
    /// JSON array of cursor tool_call events; we collapse the
    /// `running` + `completed` pair (per-call_id) into the single state
    /// the accumulator carries, with the final args + the final result.
    fn load_fixture(name: &str, call_index: usize) -> CursorToolCall {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/cursor-tools")
            .join(format!("{name}.tools.json"));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        let events: Vec<Value> = serde_json::from_str(&raw).unwrap();

        // Group by call_id, prefer status:completed (which carries the
        // result) but fall back to the last running snapshot.
        let mut grouped: std::collections::BTreeMap<String, (Value, Option<Value>)> =
            std::collections::BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        for ev in &events {
            let call_id = ev
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !grouped.contains_key(&call_id) {
                order.push(call_id.clone());
            }
            let entry = grouped.entry(call_id).or_insert_with(|| (ev.clone(), None));
            if ev.get("status").and_then(Value::as_str) == Some("completed") {
                entry.0 = ev.clone();
                entry.1 = ev.get("result").cloned();
            }
        }
        let id = order
            .get(call_index)
            .unwrap_or_else(|| panic!("fixture {name} only has {} calls", order.len()));
        let (final_event, result) = &grouped[id];
        CursorToolCall {
            call_id: id.clone(),
            name: final_event
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            args: final_event
                .get("args")
                .cloned()
                .unwrap_or(Value::Object(Default::default())),
            result: result.clone(),
            is_error: false,
        }
    }

    #[test]
    fn shell_real_fixture_maps_to_bash() {
        let tool = load_fixture("shell", 0);
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "Bash");
        assert_eq!(args["command"], "pwd");
        assert!(args["description"]
            .as_str()
            .unwrap()
            .contains("/probe-workspace"));
        assert_eq!(args["timeout"], 30000);
    }

    #[test]
    fn glob_real_fixture_maps_to_glob() {
        let tool = load_fixture("glob", 0);
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "Glob");
        assert_eq!(args["pattern"], "**/*.ts");
        assert!(args["path"]
            .as_str()
            .unwrap()
            .ends_with("/probe-workspace/src"));
    }

    #[test]
    fn grep_real_fixture_maps_to_grep() {
        let tool = load_fixture("grep", 0);
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "Grep");
        assert_eq!(args["pattern"], "TODO");
        assert!(args["path"].is_string());
    }

    #[test]
    fn read_real_fixture_maps_to_read_with_path_alias() {
        // Captured `read` fixture is empty (model summarized w/o calling
        // the tool), so synthesize a representative call against the
        // confirmed shape: `args:{path}`.
        let tool = CursorToolCall {
            call_id: "tool_x".to_string(),
            name: "read".to_string(),
            args: json!({ "path": "/r/notes.txt" }),
            result: None,
            is_error: false,
        };
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "Read");
        assert_eq!(args["file_path"], "/r/notes.txt");
    }

    #[test]
    fn edit_with_diff_synthesizes_apply_patch_add() {
        // From `write.tools.json` — cursor uses `edit` for new files
        // (linesRemoved == 0). Synthesize Claude `apply_patch` with
        // `kind.type = "add"`.
        let tool = load_fixture("write", 0);
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "apply_patch");
        let changes = args["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0]["path"].as_str().unwrap().ends_with("hello.md"));
        assert_eq!(changes[0]["kind"]["type"], "add");
        assert!(changes[0]["diff"].as_str().unwrap().contains("# Hello"));
    }

    #[test]
    fn edit_with_diff_synthesizes_apply_patch_update() {
        // From `edit.tools.json` — cursor's `edit` over an existing
        // file (linesRemoved > 0) → kind=update.
        let tool = load_fixture("edit", 1); // index 1 is the edit; index 0 is the read it did first
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "apply_patch");
        let changes = args["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["kind"]["type"], "update");
        assert!(changes[0]["kind"]["move_path"].is_null());
        assert!(changes[0]["diff"]
            .as_str()
            .unwrap()
            .contains("was replaced"));
    }

    #[test]
    fn edit_without_result_falls_back_to_edit_with_path() {
        // Mid-stream — `running` event with no result yet.
        let tool = CursorToolCall {
            call_id: "tool_x".to_string(),
            name: "edit".to_string(),
            args: json!({ "path": "/r/foo.ts" }),
            result: None,
            is_error: false,
        };
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "Edit");
        assert_eq!(args["file_path"], "/r/foo.ts");
    }

    #[test]
    fn apply_patch_passes_through_unchanged() {
        // Cursor's native apply_patch shape already matches Claude.
        let tool = CursorToolCall {
            call_id: "tool_x".to_string(),
            name: "apply_patch".to_string(),
            args: json!({
                "changes": [
                    { "path": "/r/x.md", "diff": "@@ ...", "kind": { "type": "update", "move_path": null } }
                ]
            }),
            result: None,
            is_error: false,
        };
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "apply_patch");
        assert_eq!(args, tool.args);
    }

    #[test]
    fn task_translates_to_cursor_task_with_args_passthrough() {
        // Cursor's subagent-invocation tool surfaces as `task` (lowercase).
        // We rename it to `cursor_task` (Helmor-internal namespace) and
        // pass the args through unchanged; the dedicated frontend
        // `<CursorSubagentToolCall>` renderer reads agentId/subagentType/
        // description/prompt/model/mode + result.
        let tool = CursorToolCall {
            call_id: "tool_xyz".to_string(),
            name: "task".to_string(),
            args: json!({
                "agentId": "agent-abc",
                "subagentType": "code-reviewer",
                "description": "Review the diff",
                "prompt": "Look for issues",
                "model": "composer-2",
                "mode": "auto",
            }),
            result: Some(json!({ "status": "success", "value": "Found 0 issues." })),
            is_error: false,
        };
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "cursor_task");
        // Args round-trip exactly — no key remapping for cursor task.
        assert_eq!(args, tool.args);
    }

    #[test]
    fn unknown_tool_passes_through() {
        let tool = CursorToolCall {
            call_id: "tool_x".to_string(),
            name: "mcp__server__do_thing".to_string(),
            args: json!({"x": 1}),
            result: None,
            is_error: false,
        };
        let (name, args) = translate_cursor_tool(&tool);
        assert_eq!(name, "mcp__server__do_thing");
        assert_eq!(args, json!({"x": 1}));
    }
}
