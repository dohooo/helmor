//! Shared logic for rendering Codex `collab_agent_tool_call` items.
//!
//! Both the streaming accumulator and the historical-reload adapter need
//! to map a collab item to a synthetic tool name + format the terminal
//! result text. Keeping them here ensures the two paths can't drift.

use serde_json::Value;

/// Map the raw codex `tool` field to the synthetic ToolCallPart name used
/// throughout the frontend dispatch (`isSubagentToolName`, etc.).
pub fn collab_synthetic_tool_name(tool: &str) -> &'static str {
    match tool {
        "spawnAgent" | "spawn_agent" => "subagent_spawn",
        "sendInput" | "send_input" => "subagent_send_input",
        "resumeAgent" | "resume_agent" => "subagent_resume",
        "wait" => "subagent_wait",
        "closeAgent" | "close_agent" => "subagent_close",
        _ => "subagent_unknown",
    }
}

/// Format the `tool_result` body for a terminal collab call.
///
/// - `wait` returns each sub-agent's final answer (the only tool that
///   carries useful textual output in `agentsStates[*].message`).
/// - `completed` / `failed` for other tools collapse to a short status word.
/// - Non-terminal statuses (`in_progress`, etc.) deliberately return an
///   empty string: the live-streaming path doesn't synthesize a result for
///   those, and the historical-reload path should never see them since
///   accumulator only persists on `item.completed`. Falling back to the
///   raw status word would surface "inProgress" as user-visible text.
pub fn build_collab_result_text(tool: &str, status: &str, item: &Value) -> String {
    if tool == "wait" {
        if let Some(states) = item.get("agentsStates").and_then(Value::as_object) {
            let mut out = Vec::new();
            for (tid, state) in states {
                let nickname = state
                    .get("agentNickname")
                    .and_then(Value::as_str)
                    .unwrap_or(tid);
                let role = state.get("agentRole").and_then(Value::as_str);
                let agent_status = state.get("status").and_then(Value::as_str).unwrap_or("");
                let message = state.get("message").and_then(Value::as_str).unwrap_or("");
                let header = match role {
                    Some(r) => format!("{nickname} ({r}) — {agent_status}"),
                    None => format!("{nickname} — {agent_status}"),
                };
                if message.is_empty() {
                    out.push(header);
                } else {
                    out.push(format!("{header}\n{message}"));
                }
            }
            if !out.is_empty() {
                return out.join("\n\n");
            }
        }
    }
    match status {
        "completed" => "OK".to_string(),
        "failed" => "Failed".to_string(),
        _ => String::new(),
    }
}
