//! Aggregation for Claude SDK background-task lifecycle events.
//!
//! This keeps `task_*` control events out of the rendered transcript while
//! preserving their structured state for later task-panel consumers.

use std::collections::HashMap;

use serde_json::Value;

use crate::pipeline::types::{
    ExtendedMessagePart, IntermediateMessage, MessagePart, TaskState, TaskStatus, TaskUsage,
    ThreadMessageLike,
};

#[derive(Default)]
pub(crate) struct TaskStateAccumulator {
    order: Vec<String>,
    runs: HashMap<String, TaskState>,
    tool_to_task: HashMap<String, String>,
}

impl TaskStateAccumulator {
    pub(crate) fn on_task_event(&mut self, msg: &IntermediateMessage, value: &Value) -> bool {
        if value.get("subtype").and_then(Value::as_str) == Some("task_snapshot") {
            return self.on_task_snapshot(value);
        }
        if !crate::pipeline::event_filter::is_claude_task_lifecycle(value) {
            return false;
        }
        if value.get("task_type").and_then(Value::as_str) == Some("local_workflow") {
            return false;
        }

        let Some(task_id) = self.resolve_task_id(value) else {
            // Unattributable lifecycle event (neither task_id nor
            // tool_use_id): swallow it — it is still task noise, not
            // transcript prose — but do NOT mint a phantom per-event
            // TaskState keyed by the message id (those would accumulate
            // unbounded "Untitled task" rows and persist as snapshots).
            return true;
        };
        let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
        let tool_use_id = value.get("tool_use_id").and_then(Value::as_str);
        self.link_refs(&task_id, tool_use_id);

        let state = self.ensure_state(task_id, tool_use_id);
        state.updated_at = Some(msg.created_at.clone());
        merge_string(
            &mut state.task_type,
            value.get("task_type").and_then(Value::as_str),
        );
        merge_string(
            &mut state.subagent_type,
            value.get("subagent_type").and_then(Value::as_str),
        );
        merge_string(
            &mut state.description,
            value.get("description").and_then(Value::as_str),
        );

        match subtype {
            "task_started" => {
                if state.started_at.is_none() {
                    state.started_at = Some(msg.created_at.clone());
                }
                set_status(state, TaskStatus::Running);
            }
            "task_progress" => {
                if !is_terminal(&state.status) {
                    state.status = TaskStatus::Running;
                }
                merge_string(
                    &mut state.summary,
                    value.get("summary").and_then(Value::as_str),
                );
                merge_string(
                    &mut state.last_tool_name,
                    value.get("last_tool_name").and_then(Value::as_str),
                );
                merge_usage(state, value);
            }
            "task_updated" => {
                if let Some(patch) = value.get("patch") {
                    merge_patch(state, patch);
                }
            }
            "task_notification" => {
                if let Some(status) = value.get("status").and_then(Value::as_str) {
                    set_status(state, map_status(status));
                }
                merge_string(
                    &mut state.summary,
                    value
                        .get("summary")
                        .or_else(|| value.get("message"))
                        .and_then(Value::as_str),
                );
                merge_string(
                    &mut state.output_file,
                    value.get("output_file").and_then(Value::as_str),
                );
                merge_usage(state, value);
            }
            _ => {}
        }

        true
    }

    pub(crate) fn on_tool_progress(&mut self, msg: &IntermediateMessage, value: &Value) -> bool {
        if value.get("type").and_then(Value::as_str) != Some("tool_progress") {
            return false;
        }
        let Some(task_id) = value.get("task_id").and_then(Value::as_str) else {
            return false;
        };
        let task_id = task_id.to_string();
        let tool_use_id = value.get("tool_use_id").and_then(Value::as_str);
        self.link_refs(&task_id, tool_use_id);

        let state = self.ensure_state(task_id, tool_use_id);
        state.updated_at = Some(msg.created_at.clone());
        if state.started_at.is_none() {
            state.started_at = Some(msg.created_at.clone());
        }
        if !is_terminal(&state.status) {
            state.status = TaskStatus::Running;
        }
        merge_string(
            &mut state.last_tool_name,
            value.get("tool_name").and_then(Value::as_str),
        );
        true
    }

    pub(crate) fn states(&self) -> Vec<TaskState> {
        self.order
            .iter()
            .filter_map(|id| self.runs.get(id).cloned())
            .collect()
    }

    fn on_task_snapshot(&mut self, value: &Value) -> bool {
        let Some(snapshot) = value.get("task_state").or_else(|| value.get("taskState")) else {
            return false;
        };
        let state = match serde_json::from_value::<TaskState>(snapshot.clone()) {
            Ok(state) => state,
            Err(error) => {
                // Never silently drop persisted task history: a TaskState
                // field rename would otherwise erase every historical
                // snapshot with no signal.
                tracing::warn!(%error, "Failed to deserialize persisted task_snapshot row");
                return false;
            }
        };
        let task_id = state.id.clone();
        self.link_refs(&task_id, state.tool_use_id.as_deref());
        if !self.runs.contains_key(&task_id) {
            self.order.push(task_id.clone());
        }
        self.runs.insert(task_id, state);
        true
    }

    /// Events lacking BOTH ids are unattributable — dropping them beats
    /// minting a phantom per-event TaskState keyed by the message id (which
    /// would accumulate unbounded "Untitled task" rows that also persist).
    fn resolve_task_id(&self, value: &Value) -> Option<String> {
        if let Some(id) = value.get("task_id").and_then(Value::as_str) {
            return Some(id.to_string());
        }
        let tool_use_id = value.get("tool_use_id").and_then(Value::as_str)?;
        self.tool_to_task
            .get(tool_use_id)
            .cloned()
            .or_else(|| Some(tool_use_id.to_string()))
    }

    fn link_refs(&mut self, task_id: &str, tool_use_id: Option<&str>) {
        let Some(tool_use_id) = tool_use_id else {
            return;
        };
        self.tool_to_task
            .insert(tool_use_id.to_string(), task_id.to_string());
    }

    fn ensure_state(&mut self, task_id: String, tool_use_id: Option<&str>) -> &mut TaskState {
        if !self.runs.contains_key(&task_id) {
            self.order.push(task_id.clone());
            self.runs.insert(
                task_id.clone(),
                TaskState {
                    id: task_id.clone(),
                    tool_use_id: tool_use_id.map(str::to_string),
                    description: None,
                    task_type: None,
                    subagent_type: None,
                    status: TaskStatus::Running,
                    is_backgrounded: false,
                    summary: None,
                    usage: None,
                    last_tool_name: None,
                    error: None,
                    started_at: None,
                    updated_at: None,
                    end_time_ms: None,
                    total_paused_ms: None,
                    output_file: None,
                },
            );
        }
        let state = self
            .runs
            .get_mut(&task_id)
            .expect("task state inserted above");
        if state.tool_use_id.is_none() {
            state.tool_use_id = tool_use_id.map(str::to_string);
        }
        state
    }
}

pub(super) fn attach_task_states(messages: &mut [ThreadMessageLike], acc: &TaskStateAccumulator) {
    for state in acc.states() {
        if let Some(tool_use_id) = state.tool_use_id.clone() {
            attach_to_owner(messages, tool_use_id, state);
        }
    }
}

fn attach_to_owner(
    messages: &mut [ThreadMessageLike],
    tool_use_id: String,
    state: TaskState,
) -> bool {
    for msg in messages {
        if msg
            .content
            .iter_mut()
            .any(|part| attach_to_part(part, &tool_use_id, state.clone()))
        {
            return true;
        }
    }
    false
}

fn attach_to_part(part: &mut ExtendedMessagePart, tool_use_id: &str, state: TaskState) -> bool {
    match part {
        ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_call_id,
            task_state,
            children,
            ..
        }) => {
            if tool_call_id == tool_use_id {
                *task_state = Some(Box::new(state));
                return true;
            }
            children
                .iter_mut()
                .any(|child| attach_to_part(child, tool_use_id, state.clone()))
        }
        ExtendedMessagePart::CollapsedGroup(group) => {
            for tool in &mut group.tools {
                if let MessagePart::ToolCall {
                    tool_call_id,
                    task_state,
                    ..
                } = tool
                {
                    if tool_call_id == tool_use_id {
                        *task_state = Some(Box::new(state));
                        return true;
                    }
                }
            }
            false
        }
        _ => false,
    }
}

fn merge_patch(state: &mut TaskState, patch: &Value) {
    if let Some(status) = patch.get("status").and_then(Value::as_str) {
        set_status(state, map_status(status));
    }
    merge_string(
        &mut state.description,
        patch.get("description").and_then(Value::as_str),
    );
    merge_string(&mut state.error, patch.get("error").and_then(Value::as_str));
    if let Some(is_backgrounded) = patch.get("is_backgrounded").and_then(Value::as_bool) {
        state.is_backgrounded = is_backgrounded;
    }
    if let Some(end_time) = patch.get("end_time").and_then(Value::as_u64) {
        state.end_time_ms = Some(end_time);
    }
    if let Some(total_paused_ms) = patch.get("total_paused_ms").and_then(Value::as_u64) {
        state.total_paused_ms = Some(total_paused_ms);
    }
}

fn merge_usage(state: &mut TaskState, value: &Value) {
    let Some(usage) = value.get("usage") else {
        return;
    };
    let next = TaskUsage {
        total_tokens: usage.get("total_tokens").and_then(Value::as_u64),
        tool_uses: usage.get("tool_uses").and_then(Value::as_u64),
        duration_ms: usage.get("duration_ms").and_then(Value::as_u64),
    };
    if next.total_tokens.is_some() || next.tool_uses.is_some() || next.duration_ms.is_some() {
        state.usage = Some(next);
    }
}

fn merge_string(target: &mut Option<String>, value: Option<&str>) {
    if let Some(value) = value.filter(|s| !s.is_empty()) {
        *target = Some(value.to_string());
    }
}

fn set_status(state: &mut TaskState, next: TaskStatus) {
    if is_terminal(&state.status) && !is_terminal(&next) {
        return;
    }
    state.status = next;
}

fn is_terminal(status: &TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Killed
    )
}

fn map_status(status: &str) -> TaskStatus {
    match status {
        "pending" => TaskStatus::Pending,
        "completed" => TaskStatus::Completed,
        "failed" | "errored" | "error" => TaskStatus::Failed,
        "killed" => TaskStatus::Killed,
        "paused" => TaskStatus::Paused,
        "cancelled" | "canceled" | "stopped" => TaskStatus::Cancelled,
        _ => TaskStatus::Running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_status_covers_known_variants() {
        let cases = [
            ("pending", TaskStatus::Pending),
            ("running", TaskStatus::Running),
            ("completed", TaskStatus::Completed),
            ("failed", TaskStatus::Failed),
            ("errored", TaskStatus::Failed),
            ("error", TaskStatus::Failed),
            ("killed", TaskStatus::Killed),
            ("paused", TaskStatus::Paused),
            ("cancelled", TaskStatus::Cancelled),
            ("canceled", TaskStatus::Cancelled),
            ("stopped", TaskStatus::Cancelled),
        ];

        for (input, expected) in cases {
            assert_eq!(map_status(input), expected, "status {input}");
        }
    }

    #[test]
    fn map_status_falls_back_to_running_for_unknown_status() {
        assert_eq!(map_status("unexpected"), TaskStatus::Running);
    }
}
