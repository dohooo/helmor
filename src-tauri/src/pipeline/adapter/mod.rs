//! Message adaptation: IntermediateMessage → ThreadMessageLike.
//!
//! Pipeline stages (split across submodules):
//! 1. `convert_flat` (this file) — per-message dispatch loop with
//!    lookahead tool-result merging.
//! 2. `grouping::group_child_messages` — fold child agent messages.
//! 3. `grouping::merge_adjacent_assistants` — collapse consecutive
//!    assistant messages.
//!
//! Submodules:
//! - `blocks` — per-block parsing (text, thinking, tool_use, image,
//!   document, server-tool results) and tool_result merging.
//! - `codex_items` — historical-reload Codex `item.completed` rendering.
//! - `grouping` — child grouping + adjacent assistant merging.
//! - `labels` — label and SystemNotice builders shared by the dispatch.

mod blocks;
mod codex_items;
mod grouping;
mod labels;

#[cfg(test)]
mod tests;

use serde_json::Value;

// Canonical tool names shared across adapter submodules.
pub(crate) const PROMPT_TOOL_NAME: &str = "Prompt";
pub(crate) const AGENT_TOOL_NAMES: &[&str] = &["Agent", "Task"];

use blocks::{
    assistant_has_recognized_blocks, late_merge_unresolved_tool_results, merge_tool_results,
    merge_tool_results_extended, parse_assistant_parts,
};
use grouping::{
    convert_user_message, group_child_messages, merge_adjacent_assistants,
    settle_aborted_tool_calls,
};
use labels::{
    build_error_label, build_rate_limit_notice, build_result_label, build_subagent_notice,
    build_system_label, build_system_notice, extract_fallback, make_system, make_system_notice,
};

use super::types::{
    ExtendedMessagePart, HistoricalRecord, IntermediateMessage, MessagePart, MessageRole,
    MessageStatus, ThreadMessageLike,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Convert intermediate messages into rendered thread messages.
pub fn convert(messages: &[IntermediateMessage]) -> Vec<ThreadMessageLike> {
    let flat = convert_flat(messages);
    if flat.len() <= 1 {
        return flat;
    }
    let grouped = group_child_messages(flat);
    let mut merged = merge_adjacent_assistants(grouped);
    settle_aborted_tool_calls(messages, &mut merged);
    merged
}

/// Convert historical DB records into rendered thread messages.
pub fn convert_historical(records: &[HistoricalRecord]) -> Vec<ThreadMessageLike> {
    let intermediate: Vec<IntermediateMessage> = records
        .iter()
        .map(|r| IntermediateMessage {
            id: r.id.clone(),
            role: r.role.clone(),
            raw_json: r.content.clone(),
            parsed: r.parsed_content.clone(),
            created_at: r.created_at.clone(),
            is_streaming: false,
        })
        .collect();
    convert(&intermediate)
}

// ---------------------------------------------------------------------------
// Flat conversion — per-message dispatch
// ---------------------------------------------------------------------------

fn convert_flat(messages: &[IntermediateMessage]) -> Vec<ThreadMessageLike> {
    let mut result: Vec<ThreadMessageLike> = Vec::new();
    let mut i = 0;

    while i < messages.len() {
        let msg = &messages[i];
        let parsed = msg.parsed.as_ref();
        let msg_type = parsed.and_then(|p| p.get("type")).and_then(Value::as_str);

        // system — Claude SDK control events. Subagent task_* events
        // render as SystemNotice banners; the rest fall through to the
        // generic system label.
        if msg_type == Some("system") {
            convert_system_msg(msg, &mut result);
            i += 1;
            continue;
        }

        // result (session summary)
        if msg_type == Some("result") {
            result.push(make_system(msg, &build_result_label(parsed)));
            i += 1;
            continue;
        }

        // Claude rate-limit notice. The SDK fires this on EVERY user
        // turn to report current 5h/24h utilization with `status =
        // "allowed"`, which is a usage gauge — we hide it because
        // surfacing "you're fine" on every message is just noise.
        // Only render when the user is actually throttled and needs to
        // wait (any non-allowed status: `queued`, `rejected`, etc.).
        if msg_type == Some("rate_limit_event") {
            convert_rate_limit_msg(msg, &mut result);
            i += 1;
            continue;
        }

        // Claude prompt suggestion — emitted by the SDK when it has a
        // canned next-turn prompt to offer the user.
        if msg_type == Some("prompt_suggestion") {
            let text = parsed
                .and_then(|p| p.get("suggestion"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !text.is_empty() {
                result.push(ThreadMessageLike {
                    role: MessageRole::System,
                    id: Some(msg.id.clone()),
                    created_at: Some(msg.created_at.clone()),
                    content: vec![ExtendedMessagePart::Basic(MessagePart::PromptSuggestion {
                        text,
                    })],
                    status: None,
                    streaming: None,
                });
            }
            i += 1;
            continue;
        }

        // error
        if msg_type == Some("error") || msg.role == "error" {
            result.push(make_system(msg, &build_error_label(msg, parsed)));
            i += 1;
            continue;
        }

        // assistant (by JSON type or by role for plain-text live messages)
        if msg_type == Some("assistant") || (parsed.is_none() && msg.role == "assistant") {
            let mut parts = parse_assistant_parts(parsed);
            // Pull the parent_tool_use_id (if any) so we can encode it in
            // the message id below — the grouping pass uses it to attach
            // the child to the EXACT parent Task tool, not whichever
            // Task happened to come right before it in the stream. This
            // matters when multiple subagents run in parallel and their
            // children interleave.
            let parent_tool_use_id = parsed
                .and_then(|p| p.get("parent_tool_use_id"))
                .and_then(Value::as_str);

            // Look ahead: merge following user/tool_result messages.
            // System events (subagent task_*, rate_limit_event, etc.) are
            // SDK-side notifications that arrive interleaved with the
            // assistant→user pair. They must NOT break the merge — we
            // skip past them so the tool_result still finds its parent
            // tool_use, and re-emit them after the assistant message
            // below.
            let mut deferred_system: Vec<&IntermediateMessage> = Vec::new();
            while i + 1 < messages.len() {
                let next = &messages[i + 1];
                let np = next.parsed.as_ref();
                let next_type = np.and_then(|p| p.get("type")).and_then(Value::as_str);
                if next_type == Some("system") || next_type == Some("rate_limit_event") {
                    deferred_system.push(next);
                    i += 1;
                    continue;
                }
                if next_type != Some("user") {
                    break;
                }
                if !merge_tool_results(np, &mut parts) {
                    break;
                }
                i += 1;
            }

            // Suppress the text-fallback for messages whose content array
            // contained only recognized-but-non-emitting blocks (e.g. an
            // mcp_tool_result that's expected to attach to a previous
            // ToolCall via late merge — its parts list is empty by design,
            // but we DON'T want to inject the truncated raw JSON as a Text
            // part because that produces ghost messages in the timeline).
            if parts.is_empty() && !assistant_has_recognized_blocks(parsed) {
                let fb = extract_fallback(msg);
                if !fb.is_empty() {
                    parts.push(MessagePart::Text { text: fb });
                }
            }

            let is_streaming = parsed
                .and_then(|p| p.get("__streaming"))
                .and_then(Value::as_bool)
                .unwrap_or(false);

            // Encode the parent Task's tool_use_id into the child id so
            // the grouping pass can match on it: `child:<tool_use_id>:<msg_id>`.
            let id = if let Some(pt_id) = parent_tool_use_id {
                Some(format!("child:{pt_id}:{}", msg.id))
            } else {
                Some(msg.id.clone())
            };

            result.push(ThreadMessageLike {
                role: MessageRole::Assistant,
                id,
                created_at: Some(msg.created_at.clone()),
                content: parts.into_iter().map(ExtendedMessagePart::Basic).collect(),
                status: Some(map_stop_reason(parsed)),
                streaming: if is_streaming { Some(true) } else { None },
            });

            // Re-emit any system messages we skipped over so they still
            // render in the conversation. They appear right after the
            // owning assistant turn, which keeps the visual order
            // (assistant action → SDK status update) intact. Inline
            // (no recursion, no clone) — `deferred_system` is by
            // construction a closed set of {system, rate_limit_event}
            // events, both of which have their own dedicated helpers.
            for deferred in deferred_system {
                let dtype = deferred
                    .parsed
                    .as_ref()
                    .and_then(|p| p.get("type"))
                    .and_then(Value::as_str);
                match dtype {
                    Some("system") => convert_system_msg(deferred, &mut result),
                    Some("rate_limit_event") => convert_rate_limit_msg(deferred, &mut result),
                    // The lookahead loop above only ever appends these
                    // two types — anything else would be a bug.
                    _ => debug_assert!(false, "deferred event with unexpected type: {dtype:?}"),
                }
            }

            i += 1;
            continue;
        }

        // user_prompt — a real human-typed prompt (post-migration form).
        // Distinct from `type=user`, which is the SDK's tool_result wrapper.
        if msg_type == Some("user_prompt") {
            let text = parsed
                .and_then(|p| p.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let files: Vec<String> = parsed
                .and_then(|p| p.get("files"))
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let parts = grouping::split_user_text_with_files(&text, &files);
            result.push(ThreadMessageLike {
                role: MessageRole::User,
                id: Some(msg.id.clone()),
                created_at: Some(msg.created_at.clone()),
                content: parts.into_iter().map(ExtendedMessagePart::Basic).collect(),
                status: None,
                streaming: None,
            });
            i += 1;
            continue;
        }

        // user — tool_result wrappers fold into the preceding assistant;
        // anything else either renders as a normal user message or is
        // dropped (see drop rule below).
        if msg_type == Some("user") {
            convert_user_type_msg(msg, parsed, &mut result);
            i += 1;
            continue;
        }

        // Codex: item.completed — historical-reload rendering of every
        // supported item.type. The accumulator's stream-time path
        // synthesizes Claude-shaped events; this branch goes the other
        // direction (raw item → ThreadMessageLike) so reload matches.
        if msg_type == Some("item.completed") {
            codex_items::render_item_completed(msg, parsed, &mut result);
            i += 1;
            continue;
        }

        // Codex: turn.completed — render as session summary
        if msg_type == Some("turn.completed") {
            result.push(make_system(msg, &build_result_label(parsed)));
            i += 1;
            continue;
        }

        // Codex: turn.failed — fatal turn-level error.
        if msg_type == Some("turn.failed") {
            let message = parsed
                .and_then(|p| p.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Codex turn failed");
            result.push(make_system(msg, &format!("Error: {message}")));
            i += 1;
            continue;
        }

        // user by role (plain text, non-JSON)
        if msg.role == "user" && parsed.is_none() {
            result.push(convert_user_message(msg, None));
            i += 1;
            continue;
        }

        // unknown
        let label = msg_type
            .map(|t| format!("{t} event"))
            .unwrap_or_else(|| "Event".to_string());
        result.push(make_system(msg, &label));
        i += 1;
    }

    // Late-merge: parent Task/Agent tool_results live AFTER all subagent
    // child messages, so the per-message lookahead above breaks before
    // reaching them. This pass walks the input one more time and patches
    // any ToolCall still missing a `result`.
    late_merge_unresolved_tool_results(messages, &mut result);

    result
}

/// Translate Claude's `BetaMessage.stop_reason` into a unified
/// `MessageStatus`. Both providers' assistant messages flow through this:
/// Claude carries the actual reason in `parsed.message.stop_reason`, Codex
/// has no equivalent and falls into the `None` arm (always
/// `complete / stop`). The frontend reads `status.reason` only — it never
/// sees the underlying provider, and any new SDK reason added later just
/// needs an arm here.
fn map_stop_reason(parsed: Option<&Value>) -> MessageStatus {
    let reason = parsed
        .and_then(|p| p.get("message"))
        .and_then(|m| m.get("stop_reason"))
        .and_then(Value::as_str);
    match reason {
        // Normal completion variants — all map to "complete / stop" so
        // the frontend doesn't need to distinguish them.
        Some("end_turn") | Some("stop_sequence") | Some("tool_use") | Some("compaction") | None => {
            MessageStatus {
                status_type: "complete".to_string(),
                reason: Some("stop".to_string()),
            }
        }
        // Truncation by output budget — the assistant message is cut off
        // mid-content. Distinguished from `assistant.error = max_output_tokens`
        // (which uses the same `max_tokens` reason) so the frontend renders
        // a single "truncated" badge regardless of which surface caused it.
        Some("max_tokens") => MessageStatus {
            status_type: "incomplete".to_string(),
            reason: Some("max_tokens".to_string()),
        },
        // Model voluntarily paused mid-turn (rare).
        Some("pause_turn") => MessageStatus {
            status_type: "incomplete".to_string(),
            reason: Some("pause_turn".to_string()),
        },
        // Claude refused to answer (safety / policy).
        Some("refusal") => MessageStatus {
            status_type: "incomplete".to_string(),
            reason: Some("refusal".to_string()),
        },
        // Context window exhausted before the turn could finish.
        Some("model_context_window_exceeded") => MessageStatus {
            status_type: "incomplete".to_string(),
            reason: Some("context_window_exceeded".to_string()),
        },
        // Forward-compat: a brand new SDK stop_reason gets passed through
        // as-is. Better to surface "unknown" verbatim than silently coerce
        // it to "stop" — the user's UI will at least show *something*.
        Some(other) => MessageStatus {
            status_type: "complete".to_string(),
            reason: Some(other.to_string()),
        },
    }
}

// ---------------------------------------------------------------------------
// Per-event helpers shared by the main loop and the deferred-flush path
// ---------------------------------------------------------------------------

/// Handle a `type=user` message. Three sub-paths:
/// 1. **Merge tool_result** — fold into the preceding assistant in-place.
/// 2. **Prompt fold** — subagent prompt (`parent_tool_use_id` set) becomes
///    a synthesized `Prompt` ToolCall for the grouping pass.
/// 3. **Stray / normal** — drop malformed wrappers, render the rest.
fn convert_user_type_msg(
    msg: &IntermediateMessage,
    parsed: Option<&Value>,
    out: &mut Vec<ThreadMessageLike>,
) {
    // 1. Try merging tool_result blocks into the preceding assistant.
    let merged = out
        .last_mut()
        .filter(|prev| prev.role == MessageRole::Assistant)
        .is_some_and(|prev| merge_tool_results_extended(parsed, &mut prev.content));
    if merged {
        return;
    }

    // 2. Subagent prompt — `parent_tool_use_id` is set. The Claude SDK
    //    emits the subagent's initial prompt as a `type=user` text wrapper
    //    inside the parent's stream. Fold it into the parent Task's
    //    `children` list as a synthesized `ToolCall` with `tool_name =
    //    "Prompt"` so the frontend renders it identically to every other
    //    child entry. The grouping pass picks up the
    //    `child:<parent_tool_id>:<msg_id>` id and appends this synthetic
    //    ToolCall to the parent Task's children.
    if let Some(parent_tool_id) = parsed
        .and_then(|p| p.get("parent_tool_use_id"))
        .and_then(Value::as_str)
    {
        let text = extract_user_text(parsed);
        if !text.is_empty() {
            let args = serde_json::json!({ "text": text });
            let args_text = args.to_string();
            out.push(ThreadMessageLike {
                role: MessageRole::User,
                id: Some(format!("child:{parent_tool_id}:{}", msg.id)),
                created_at: Some(msg.created_at.clone()),
                content: vec![ExtendedMessagePart::Basic(MessagePart::ToolCall {
                    tool_call_id: format!("prompt-{}", msg.id),
                    tool_name: PROMPT_TOOL_NAME.to_string(),
                    args,
                    args_text,
                    result: None,
                    is_error: None,
                    streaming_status: None,
                    children: Vec::new(),
                })],
                status: None,
                streaming: None,
            });
        }
        return;
    }

    // 3. Stray top-level user wrapper — non-tool_result with no preceding
    //    assistant to attach context to. Treated as a malformed SDK event
    //    and dropped. Anything else is a real user turn and renders
    //    normally.
    let has_prev_assistant = out.last().is_some_and(|m| m.role == MessageRole::Assistant);
    if parsed.is_some() && !has_prev_assistant {
        return;
    }
    out.push(convert_user_message(msg, parsed));
}

/// Convert a single `system` event into zero or one ThreadMessageLike,
/// pushing the result onto `out`. Used by the main `convert_flat` loop
/// AND by the post-assistant deferred flush so neither has to recurse.
fn convert_system_msg(msg: &IntermediateMessage, out: &mut Vec<ThreadMessageLike>) {
    let parsed = msg.parsed.as_ref();
    let sub = parsed
        .and_then(|p| p.get("subtype"))
        .and_then(Value::as_str);
    // Apply the same noise filter live ingest uses, so old persisted
    // rows from earlier code versions render with the new rules. Edit
    // `pipeline::event_filter` to toggle.
    if let Some(s) = sub {
        if super::event_filter::is_suppressed_system_subtype(s) {
            return;
        }
    }
    if let Some(part) = build_subagent_notice(sub, parsed) {
        // Mark with `child:<tool_use_id>:<msg_id>` so the parent-grouping
        // pass folds these notices into the corresponding Task tool
        // call's children block. The tool_use_id field on the SDK
        // system event is the id of the Task tool that spawned the
        // subagent.
        let mut notice = make_system_notice(msg, part);
        if let Some(tool_use_id) = parsed
            .and_then(|p| p.get("tool_use_id"))
            .and_then(Value::as_str)
        {
            notice.id = Some(format!("child:{tool_use_id}:{}", msg.id));
        }
        out.push(notice);
        return;
    }
    // Subtypes with structured data (compact_boundary, api_retry,
    // tool_use_summary, local_command_output) flow through a single
    // dispatcher in `labels::build_system_notice`. Adding a new
    // subtype is one match arm, no convert_system_msg edits.
    if let Some(part) = build_system_notice(parsed) {
        out.push(make_system_notice(msg, part));
        return;
    }
    out.push(make_system(msg, &build_system_label(parsed)));
}

/// Concatenate every `text` block from a `type=user` payload's
/// `message.content` array. Used by the subagent-prompt fold path —
/// the SDK wraps the prompt as `{message: {content: [{type: "text",
/// text: "..."}]}}` and we collapse all text blocks into a single
/// string (joined with newlines if there are multiple).
fn extract_user_text(parsed: Option<&Value>) -> String {
    let Some(content) = parsed
        .and_then(|p| p.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    content
        .iter()
        .filter_map(|c| {
            if c.get("type").and_then(Value::as_str) == Some("text") {
                c.get("text").and_then(Value::as_str).map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Convert a single `rate_limit_event` into zero or one
/// ThreadMessageLike. The SDK fires this on every user turn to report
/// current 5h/24h utilization with statuses like `allowed`,
/// `allowed_warning`, `queued`, `rejected`, etc. Only `rejected`
/// actually means the request was blocked — everything else is a
/// usage gauge and we hide it.
fn convert_rate_limit_msg(msg: &IntermediateMessage, out: &mut Vec<ThreadMessageLike>) {
    let parsed = msg.parsed.as_ref();
    let status = parsed
        .and_then(|p| p.get("rate_limit_info"))
        .and_then(|i| i.get("status"))
        .and_then(Value::as_str);
    if status == Some("rejected") {
        out.push(make_system_notice(msg, build_rate_limit_notice(parsed)));
    }
}
