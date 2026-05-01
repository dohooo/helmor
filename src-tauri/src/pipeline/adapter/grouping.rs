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

fn is_cumulative_same_id_snapshot(prev: &ThreadMessageLike, next: &ThreadMessageLike) -> bool {
    if prev.id != next.id || next.content.len() < prev.content.len() {
        return false;
    }

    prev.content
        .iter()
        .zip(next.content.iter())
        .all(|(prev_part, next_part)| {
            std::mem::discriminant(prev_part) == std::mem::discriminant(next_part)
                && prev_part.part_id() == next_part.part_id()
        })
}

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
            for (idx, b) in blocks.iter().enumerate() {
                if let Some(obj) = b.as_object() {
                    if obj.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = obj.get("text").and_then(Value::as_str) {
                            let id = obj
                                .get("__part_id")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("{}:blk:{idx}", msg.id));
                            parts.push(MessagePart::Text {
                                id,
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
            id: format!("{}:fallback", msg.id),
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

/// Split `text` on `@<path>` substrings (longer paths win on overlap),
/// returning interleaved Text and FileMention parts.
///
/// `files` and `images` are merged into a single needle pool — the
/// renderer routes by extension. Both must be passed in: paths
/// containing whitespace can only round-trip when matched against a
/// structured needle, never via regex. Mirrors the TypeScript
/// `splitTextWithFiles(text, files, msgId, images)` so optimistic and
/// persisted renders stay byte-identical.
pub(crate) fn split_user_text_with_files(
    text: &str,
    files: &[String],
    images: &[String],
    msg_id: &str,
) -> Vec<MessagePart> {
    let text_id = |idx: usize| format!("{msg_id}:txt:{idx}");
    let mention_id = |idx: usize| format!("{msg_id}:mention:{idx}");

    if (files.is_empty() && images.is_empty()) || text.is_empty() {
        return vec![MessagePart::Text {
            id: text_id(0),
            text: text.to_string(),
        }];
    }

    let mut needles: Vec<&String> = files.iter().chain(images.iter()).collect();
    needles.sort_by_key(|f| std::cmp::Reverse(f.len()));

    // (start_byte, end_byte, path) — kept non-overlapping by construction.
    let mut matches: Vec<(usize, usize, String)> = Vec::new();
    for needle_str in &needles {
        if needle_str.is_empty() {
            continue;
        }
        let needle = format!("@{needle_str}");
        let mut search_start = 0usize;
        while let Some(rel) = text[search_start..].find(&needle) {
            let abs_start = search_start + rel;
            let abs_end = abs_start + needle.len();
            let overlaps = matches
                .iter()
                .any(|(s, e, _)| !(abs_end <= *s || abs_start >= *e));
            if !overlaps {
                matches.push((abs_start, abs_end, (*needle_str).clone()));
            }
            search_start = abs_end;
        }
    }

    if matches.is_empty() {
        return vec![MessagePart::Text {
            id: text_id(0),
            text: text.to_string(),
        }];
    }

    matches.sort_by_key(|(s, _, _)| *s);

    let mut parts: Vec<MessagePart> = Vec::new();
    let mut cursor = 0usize;
    let mut text_seq = 0usize;
    for (mention_seq, (start, end, path)) in matches.into_iter().enumerate() {
        if cursor < start {
            let chunk = &text[cursor..start];
            if !chunk.is_empty() {
                parts.push(MessagePart::Text {
                    id: text_id(text_seq),
                    text: chunk.to_string(),
                });
                text_seq += 1;
            }
        }
        parts.push(MessagePart::FileMention {
            id: mention_id(mention_seq),
            path,
        });
        cursor = end;
    }
    if cursor < text.len() {
        let tail = &text[cursor..];
        if !tail.is_empty() {
            parts.push(MessagePart::Text {
                id: text_id(text_seq),
                text: tail.to_string(),
            });
        }
    }

    parts
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
                    if super::AGENT_TOOL_NAMES.contains(&tool_name.as_str()) {
                        index.insert(tool_call_id.clone(), (new_idx, cidx));
                    }
                }
            }
        }
    }

    out
}

/// If the input contains an abort notice row, fill `result` on every
/// unresolved Agent/Task ToolCall so frontend's `isRunning` is false.
pub(super) fn settle_aborted_tool_calls(
    input: &[IntermediateMessage],
    out: &mut [ThreadMessageLike],
) {
    let aborted = input.iter().any(|m| {
        m.role == MessageRole::Error
            && m.parsed
                .as_ref()
                .and_then(|p| p.get("content").and_then(Value::as_str))
                .is_some_and(|c| c == "aborted by user")
    });
    if !aborted {
        return;
    }
    for msg in out.iter_mut() {
        settle_agent_results(&mut msg.content);
    }
}

fn settle_agent_results(parts: &mut [ExtendedMessagePart]) {
    for part in parts.iter_mut() {
        let ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_name,
            result,
            children,
            ..
        }) = part
        else {
            continue;
        };
        if super::AGENT_TOOL_NAMES.contains(&tool_name.as_str()) && result.is_none() {
            // Empty string makes isRunning=false without rendering text.
            *result = Some(Value::String(String::new()));
        }
        settle_agent_results(children);
    }
}

pub(super) fn merge_adjacent_assistants(msgs: Vec<ThreadMessageLike>) -> Vec<ThreadMessageLike> {
    let mut out: Vec<ThreadMessageLike> = Vec::new();

    for msg in msgs {
        let should_merge = matches!(
            (out.last().map(|p| &p.role), &msg.role),
            (Some(MessageRole::Assistant), MessageRole::Assistant)
        ) && !assistant_contains_plan_review(out.last())
            && !message_contains_plan_review(&msg);

        if should_merge {
            let prev = out.last_mut().unwrap();
            if is_cumulative_same_id_snapshot(prev, &msg) {
                prev.content = msg.content;
                prev.status = msg.status;
                prev.streaming = msg.streaming;
            } else {
                prev.content.extend(msg.content);
                if msg.status.is_some() {
                    prev.status = msg.status;
                }
                if prev.streaming == Some(true) || msg.streaming == Some(true) {
                    prev.streaming = Some(true);
                }
            }
        } else {
            out.push(msg);
        }
    }

    out
}

fn assistant_contains_plan_review(message: Option<&ThreadMessageLike>) -> bool {
    message.is_some_and(message_contains_plan_review)
}

fn message_contains_plan_review(message: &ThreadMessageLike) -> bool {
    message.content.iter().any(|part| {
        matches!(
            part,
            ExtendedMessagePart::Basic(MessagePart::PlanReview { .. })
        )
    })
}
