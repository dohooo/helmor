//! Post-conversion passes that operate on `Vec<ThreadMessageLike>`.
//!
//! Three transforms run after `convert_flat`:
//! 1. `convert_user_message` — also used inline by the dispatch loop
//!    when a `user` message has no parent assistant.
//! 2. `group_child_messages` — fold sub-agent assistant messages into
//!    their parent Task tool call's children block.
//! 3. `merge_adjacent_assistants` — collapse consecutive assistant
//!    messages so streaming deltas show as one bubble.

use std::collections::HashMap;

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
/// That distinction matters when multiple subagents run in parallel and
/// their children interleave — adjacency-based grouping would
/// misattribute late-arriving children of subagent 1 to subagent 2 or 3
/// just because they landed after a different Task tool in the timeline.
///
/// Implementation: an `index` HashMap maps each Agent/Task
/// `tool_call_id` to its location in `out` as `(out_idx, content_idx)`.
/// We build it incrementally — every time a non-child message is
/// pushed onto `out`, we scan its content for new Agent/Task tools and
/// register them. Children then do an O(1) lookup.
fn group_child_messages_under_parent(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let mut out: Vec<ThreadMessageLike> = Vec::new();
    // tool_call_id → (out_idx, content_idx) for every Agent/Task tool
    // currently in `out`. Built incrementally as new messages land.
    let mut index: HashMap<String, (usize, usize)> = HashMap::new();

    for m in msgs.into_iter() {
        let parent_tool_id =
            m.id.as_ref()
                .and_then(|id| id.strip_prefix("child:"))
                .and_then(|rest| rest.split(':').next());

        if let Some(target_tool_id) = parent_tool_id {
            if let Some(&(out_idx, content_idx)) = index.get(target_tool_id) {
                if let ExtendedMessagePart::Basic(MessagePart::ToolCall { children, .. }) =
                    &mut out[out_idx].content[content_idx]
                {
                    children.extend_from_slice(&m.content);
                    continue;
                }
            }
            // Orphan: no matching parent Task in the rendered output
            // (e.g. parent flushed in a different turn). Fall through
            // and render the child standalone so the user still sees
            // the work — better than dropping it.
            out.push(m);
            continue;
        }
        // Non-child message — push first, then register any Agent/Task
        // ToolCalls it contains so subsequent children can find them.
        let new_idx = out.len();
        out.push(m);
        if out[new_idx].role == MessageRole::Assistant {
            for (cidx, part) in out[new_idx].content.iter().enumerate() {
                if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
                    tool_name,
                    tool_call_id,
                    ..
                }) = part
                {
                    if tool_name == "Agent" || tool_name == "Task" {
                        index.insert(tool_call_id.clone(), (new_idx, cidx));
                    }
                }
            }
        }
    }

    out
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
