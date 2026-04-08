//! Post-conversion passes that operate on `Vec<ThreadMessageLike>`.
//!
//! Three transforms run after `convert_flat`:
//! 1. `convert_user_message` — also used inline by the dispatch loop
//!    when a `user` message has no parent assistant.
//! 2. `group_child_messages` — fold sub-agent assistant messages into
//!    their parent Task tool call's children block.
//! 3. `merge_adjacent_assistants` — collapse consecutive assistant
//!    messages so streaming deltas show as one bubble.

use serde_json::Value;

use super::labels::extract_fallback;
use crate::pipeline::types::{
    ExtendedMessagePart, IntermediateMessage, MessagePart, MessageRole, ThreadMessageLike,
};

pub(super) fn convert_user_message(
    msg: &IntermediateMessage,
    parsed: Option<&Value>,
) -> ThreadMessageLike {
    let mut parts: Vec<MessagePart> = Vec::new();

    if let Some(p) = parsed {
        let message = p.get("message").and_then(|v| v.as_object());
        if let Some(blocks) = message
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for b in blocks {
                if let Some(obj) = b.as_object() {
                    if obj.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = obj.get("text").and_then(Value::as_str) {
                            parts.push(MessagePart::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    if parts.is_empty() {
        parts.push(MessagePart::Text {
            text: extract_fallback(msg),
        });
    }

    ThreadMessageLike {
        role: MessageRole::User,
        id: Some(msg.id.clone()),
        created_at: Some(msg.created_at.clone()),
        content: parts.into_iter().map(ExtendedMessagePart::Basic).collect(),
        status: None,
        streaming: None,
    }
}

pub(super) fn group_child_messages(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let has_children = msgs
        .iter()
        .any(|m| m.id.as_ref().is_some_and(|id| id.starts_with("child:")));
    if !has_children {
        return msgs;
    }
    group_child_messages_under_parent(msgs)
}

/// Group children under their parent Agent/Task tool-call by matching
/// the encoded `parent_tool_use_id` against the tool's `tool_call_id`.
///
/// Each child message id has the form `child:<parent_tool_use_id>:<msg_id>`
/// so this pass can attach a child to the EXACT Task that spawned it,
/// not whichever Task happened to come right before it in the stream.
/// That distinction matters when multiple subagents run in parallel
/// and their children interleave: an adjacency-based grouping (the
/// previous implementation) would attribute late-arriving children of
/// subagent 1 to subagent 2 or 3 just because they happened to land
/// after a different Task tool in the timeline.
fn group_child_messages_under_parent(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let mut out: Vec<ThreadMessageLike> = Vec::new();

    for m in msgs.into_iter() {
        let parent_tool_id =
            m.id.as_ref()
                .and_then(|id| id.strip_prefix("child:"))
                .and_then(|rest| rest.split(':').next())
                .map(str::to_string);

        if let Some(target_tool_id) = parent_tool_id {
            if attach_to_tool(&mut out, &target_tool_id, &m.content) {
                continue;
            }
            // Orphan: no matching parent Task in the rendered output
            // (e.g. parent flushed in a different turn). Fall through
            // and render the child standalone so the user still sees
            // the work — better than dropping it.
            out.push(m);
            continue;
        }
        out.push(m);
    }

    out
}

/// Walk the rendered output from newest to oldest looking for an
/// Agent/Task ToolCall whose `tool_call_id` matches `target_tool_id`,
/// then append `parts` to its `__children__` payload. Returns true
/// when an attachment happened.
///
/// Children stream in incrementally, so each call may add to an
/// existing children list. We re-parse the previous `__children__`
/// JSON, append the new parts, and re-serialize. This is O(n²) on
/// the children of a single subagent but in practice n is small
/// (~hundreds) and the alternative — building a HashMap upfront —
/// would lose the in-place mutation that keeps the rendered tree
/// stable across re-renders.
fn attach_to_tool(
    out: &mut [ThreadMessageLike],
    target_tool_id: &str,
    parts: &[ExtendedMessagePart],
) -> bool {
    for msg in out.iter_mut().rev() {
        if msg.role != MessageRole::Assistant {
            continue;
        }
        for part in msg.content.iter_mut() {
            if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                tool_name,
                tool_call_id,
                result,
                ..
            }) = part
            {
                if (tool_name == "Agent" || tool_name == "Task") && tool_call_id == target_tool_id {
                    let mut existing = parse_existing_children(result.as_ref());
                    existing.extend_from_slice(parts);
                    let json = serde_json::to_string(&existing).unwrap_or_default();
                    *result = Some(Value::String(format!("__children__{{\"parts\":{json}}}")));
                    return true;
                }
            }
        }
    }
    false
}

/// Parse a previously-attached `__children__` payload back into a
/// `Vec<ExtendedMessagePart>` so the next child append builds on the
/// existing list. Returns an empty vec when the result is unset or
/// not a children marker — both are valid first-call states.
fn parse_existing_children(result: Option<&Value>) -> Vec<ExtendedMessagePart> {
    let Some(Value::String(s)) = result else {
        return Vec::new();
    };
    let Some(rest) = s.strip_prefix("__children__") else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(rest) else {
        return Vec::new();
    };
    let Some(parts) = parsed.get("parts") else {
        return Vec::new();
    };
    serde_json::from_value(parts.clone()).unwrap_or_default()
}

pub(super) fn merge_adjacent_assistants(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let mut out: Vec<ThreadMessageLike> = Vec::new();

    for msg in msgs {
        let should_merge = matches!(
            (out.last().map(|p| &p.role), &msg.role),
            (Some(MessageRole::Assistant), MessageRole::Assistant)
        );

        if should_merge {
            let prev = out.last_mut().unwrap();
            prev.content.extend(msg.content);
            if msg.status.is_some() {
                prev.status = msg.status;
            }
            if prev.streaming == Some(true) || msg.streaming == Some(true) {
                prev.streaming = Some(true);
            }
        } else {
            out.push(msg);
        }
    }

    out
}
