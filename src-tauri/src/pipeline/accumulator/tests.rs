//! Unit tests for `StreamAccumulator`.
//!
//! Mostly black-box: each test pushes a sequence of raw events and asserts
//! on the public snapshot/turn output. The few private methods touched
//! (`snapshot`, `turns_len`, etc.) are exposed via `pub(crate)` or
//! `#[cfg(test)] pub fn` accessors on `StreamAccumulator`.

use super::*;
use serde_json::json;

#[test]
fn accumulate_text_deltas() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": " world"}
            }
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    assert!(snapshot[0].is_streaming);
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    let text = parsed["message"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(text, "Hello world");
}

#[test]
fn accumulate_tool_use_blocks() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "tc1", "name": "read"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": "{\"file_path\""}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": ": \"/a.txt\"}"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0}
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    let block = &parsed["message"]["content"][0];
    assert_eq!(block["name"].as_str().unwrap(), "read");
    assert_eq!(block["__streaming_status"].as_str().unwrap(), "running");
}

#[test]
fn full_assistant_clears_blocks() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    // Add a text block
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "hello"}
            }
        }),
        "",
    );

    // Full assistant message arrives — should clear blocks
    let full_msg = json!({
        "type": "assistant",
        "message": {
            "id": "msg1",
            "role": "assistant",
            "content": [{"type": "text", "text": "hello"}]
        }
    });
    let raw = serde_json::to_string(&full_msg).unwrap();
    acc.push_event(&full_msg, &raw);

    let snapshot = acc.snapshot("ctx", "sess");
    // Should have the collected full message, no streaming partial
    assert_eq!(snapshot.len(), 1);
    assert!(!snapshot[0].is_streaming);
}

#[test]
fn codex_command_execution_synthesis() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");
    let event = json!({
        "type": "item/completed",
        "itemId": "cmd1",
        "item": {
            "type": "commandExecution",
            "id": "cmd1",
            "command": "ls -la",
            "output": "file1.txt\nfile2.txt",
            "exitCode": 0
        }
    });
    let raw = serde_json::to_string(&event).unwrap();
    acc.push_event(&event, &raw);

    let snapshot = acc.snapshot("ctx", "sess");
    // Should have synthetic assistant (tool_use) + user (tool_result)
    assert_eq!(snapshot.len(), 2);
    assert_eq!(snapshot[0].role, "assistant");
    assert_eq!(snapshot[1].role, "user");
}

#[test]
fn partial_identity_stays_stable_across_deltas() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": "{\"command\":\"ls\""}
            }
        }),
        "",
    );

    let first = acc.snapshot("ctx", "sess").pop().unwrap();

    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": ",\"cwd\":\"/tmp\"}"}
            }
        }),
        "",
    );

    let second = acc.snapshot("ctx", "sess").pop().unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.created_at, second.created_at);
}

#[test]
fn finalized_assistant_reuses_partial_id() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"command\":\"git status --short\"}"
                }
            }
        }),
        "",
    );

    let partial_id = acc.snapshot("ctx", "sess").pop().unwrap().id;
    let full_msg = json!({
        "type": "assistant",
        "message": {
            "type": "message",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "tool-1",
                "name": "Bash",
                "input": {"command": "git status --short"}
            }]
        }
    });
    let raw = serde_json::to_string(&full_msg).unwrap();
    acc.push_event(&full_msg, &raw);

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].id, partial_id);
}

#[test]
fn fallback_delta_accumulation() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    // Legacy delta without block structure
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "delta": {"text": "Hello", "thinking": "hmm"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "delta": {"text": " world"}
            }
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    assert!(snapshot[0].is_streaming);
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    // Should have thinking + text blocks
    let content = parsed["message"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 2);
}

/// Regression: the final assistant turn was silently dropped because
/// agents.rs consumed the accumulator before flushing it.
#[test]
fn flush_pending_flushes_final_assistant_into_turns() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    // 1. A complete tool_use turn — this one DOES get flushed at the
    //    moment the next assistant arrives, because the next assistant
    //    has a different msg_id. Mirrors a typical "Claude calls a
    //    tool, gets the result, then writes a final reply" sequence.
    let asst_with_tool = json!({
        "type": "assistant",
        "message": {
            "id": "msg_tool",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "t1",
                "name": "Read",
                "input": {"file_path": "/x"}
            }]
        }
    });
    acc.push_event(&asst_with_tool, &asst_with_tool.to_string());

    // 2. A user tool_result — flushes the previous assistant into turns.
    let user_tool_result = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "t1",
                "content": "file contents"
            }]
        }
    });
    acc.push_event(&user_tool_result, &user_tool_result.to_string());

    // After step 2: tool turn + user turn = 2 turns
    assert_eq!(
        acc.turns_len(),
        2,
        "tool_use assistant + tool_result user should both be flushed"
    );

    // 3. The final assistant reply with text + thinking blocks.
    //    Stays staged in cur_asst_* — NO flush trigger fires for it.
    let asst_final = json!({
        "type": "assistant",
        "message": {
            "id": "msg_final",
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "let me summarize"},
                {"type": "text", "text": "Here's the answer."}
            ]
        }
    });
    acc.push_event(&asst_final, &asst_final.to_string());

    // 4. result event — does NOT flush.
    let result = json!({
        "type": "result",
        "subtype": "success",
        "result": "Here's the answer.",
        "usage": {"input_tokens": 10, "output_tokens": 5}
    });
    acc.push_event(&result, &result.to_string());

    // Pre-finalize state: the final assistant turn is still staged,
    // turns_len() reports only the 2 already-flushed turns.
    assert_eq!(
        acc.turns_len(),
        2,
        "final assistant turn should still be staged in cur_asst_*"
    );

    // The fix: flush_pending must flush the staged turn AND leave the
    // accumulator alive so the caller can read it.
    acc.flush_pending();
    let output = acc.drain_output(Some("sess-xyz"));

    // Post-finalize: the staged turn is now in self.turns, observable
    // on the SAME accumulator instance the caller still owns.
    assert_eq!(
        acc.turns_len(),
        3,
        "flush_pending should flush the staged final assistant into self.turns"
    );

    // The flushed turn is the final assistant message, with both
    // thinking and text blocks intact.
    let final_turn = acc.turn_at(2);
    assert_eq!(final_turn.role, "assistant");
    let parsed: serde_json::Value = serde_json::from_str(&final_turn.content_json).unwrap();
    let blocks = parsed["message"]["content"].as_array().unwrap();
    assert_eq!(
        blocks.len(),
        2,
        "final turn should preserve both thinking and text blocks"
    );
    assert_eq!(blocks[0]["type"].as_str(), Some("thinking"));
    assert_eq!(blocks[1]["type"].as_str(), Some("text"));
    assert_eq!(blocks[1]["text"].as_str(), Some("Here's the answer."));

    // ParsedAgentOutput should also expose the assistant text.
    assert!(output.assistant_text.contains("Here's the answer."));
}

/// Regression for the "thinking blocks silently dropped" bug.
///
/// The Claude SDK delivers each finalized content block as its OWN
/// `assistant` event with the same `msg_id` — i.e., delta-style, not
/// cumulative snapshot. The buggy code in `handle_assistant` did
/// `cur_asst_blocks = blocks.clone()` on every event, which clobbered
/// any prior block of the same turn.
///
/// In production this manifested as: every `thinking` block immediately
/// followed by a `tool_use` (or `text`) block of the same msg_id was
/// silently dropped before persistence. DB inspection from 2026-04
/// onward showed zero `thinking`-containing assistant rows in any
/// post-migration session.
///
/// Fix: when the new event has the same `msg_id` as the currently
/// batching turn, append blocks to `cur_asst_blocks` instead of
/// replacing them. This test pins the contract.
#[test]
fn delta_assistant_events_with_same_msg_id_append_blocks() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    // Mirror the real Claude SDK pattern: thinking → tool_use → tool_result.
    // Both assistant events share the same msg_id; each contains a
    // single delta block.
    let asst_thinking = json!({
        "type": "assistant",
        "message": {
            "id": "msg_shared",
            "role": "assistant",
            "content": [{
                "type": "thinking",
                "thinking": "Let me read the file first."
            }]
        }
    });
    acc.push_event(&asst_thinking, &asst_thinking.to_string());

    let asst_tool = json!({
        "type": "assistant",
        "message": {
            "id": "msg_shared",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "tool_1",
                "name": "Read",
                "input": {"file_path": "/x"}
            }]
        }
    });
    acc.push_event(&asst_tool, &asst_tool.to_string());

    // tool_result triggers the flush of the batched assistant turn.
    let user_tool_result = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "tool_1",
                "content": "file contents"
            }]
        }
    });
    acc.push_event(&user_tool_result, &user_tool_result.to_string());

    // After flush: 1 assistant turn + 1 user turn = 2.
    assert_eq!(acc.turns_len(), 2);

    // The flushed assistant turn must contain BOTH the thinking AND
    // the tool_use blocks. Buggy code dropped the thinking entirely,
    // persisting only [tool_use].
    let asst_turn = acc.turn_at(0);
    assert_eq!(asst_turn.role, "assistant");
    let parsed: serde_json::Value = serde_json::from_str(&asst_turn.content_json).unwrap();
    let blocks = parsed["message"]["content"].as_array().unwrap();
    assert_eq!(
        blocks.len(),
        2,
        "delta-style same-msg_id events should be merged into one turn with both blocks"
    );
    assert_eq!(blocks[0]["type"].as_str(), Some("thinking"));
    assert_eq!(blocks[1]["type"].as_str(), Some("tool_use"));
    assert_eq!(
        blocks[0]["thinking"].as_str(),
        Some("Let me read the file first.")
    );
    assert_eq!(blocks[1]["id"].as_str(), Some("tool_1"));
}

/// Different msg_id should still REPLACE, not append. Pins the boundary
/// case so a future "always append" mistake gets caught.
#[test]
fn delta_assistant_events_with_different_msg_id_flush_then_replace() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    let asst_a = json!({
        "type": "assistant",
        "message": {
            "id": "msg_A",
            "role": "assistant",
            "content": [{"type": "text", "text": "first turn"}]
        }
    });
    acc.push_event(&asst_a, &asst_a.to_string());

    // Different msg_id triggers flush of msg_A first, then starts msg_B fresh.
    let asst_b = json!({
        "type": "assistant",
        "message": {
            "id": "msg_B",
            "role": "assistant",
            "content": [{"type": "text", "text": "second turn"}]
        }
    });
    acc.push_event(&asst_b, &asst_b.to_string());

    // msg_A flushed → 1 turn so far. msg_B is still staged.
    assert_eq!(acc.turns_len(), 1);
    let first_turn: serde_json::Value = serde_json::from_str(&acc.turn_at(0).content_json).unwrap();
    assert_eq!(first_turn["message"]["id"].as_str(), Some("msg_A"));
    let first_blocks = first_turn["message"]["content"].as_array().unwrap();
    assert_eq!(first_blocks.len(), 1);
    assert_eq!(first_blocks[0]["text"].as_str(), Some("first turn"));

    // flush_pending flushes msg_B into turns.
    acc.flush_pending();
    assert_eq!(acc.turns_len(), 2);
    let second_turn: serde_json::Value =
        serde_json::from_str(&acc.turn_at(1).content_json).unwrap();
    assert_eq!(second_turn["message"]["id"].as_str(), Some("msg_B"));
    let second_blocks = second_turn["message"]["content"].as_array().unwrap();
    assert_eq!(second_blocks.len(), 1);
    assert_eq!(second_blocks[0]["text"].as_str(), Some("second turn"));
}

// ---------------------------------------------------------------------------
// R6: Codex todo_list synthesis — push an item.completed of type
// todo_list and verify the accumulator synthesizes a Claude-shaped
// `TodoWrite` tool_use intermediate so the adapter can collapse it
// uniformly with Claude's TodoWrite.
// ---------------------------------------------------------------------------

#[test]
fn codex_todo_list_synthesizes_claude_todowrite_tool_use() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");
    let event = json!({
        "type": "item/completed",
        "itemId": "todo_evt_1",
        "item": {
            "type": "todoList",
            "id": "todo_evt_1",
            "items": [
                {"text": "Plan the work", "completed": true},
                {"text": "Write tests", "completed": false},
            ]
        }
    });
    acc.push_event(&event, &event.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(
        snapshot.len(),
        1,
        "expected one synthesized assistant intermediate"
    );
    assert_eq!(snapshot[0].role, "assistant");
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    let block = &parsed["message"]["content"][0];
    assert_eq!(block["type"].as_str(), Some("tool_use"));
    assert_eq!(block["name"].as_str(), Some("TodoWrite"));
    let todos = block["input"]["todos"].as_array().unwrap();
    assert_eq!(todos.len(), 2);
    assert_eq!(todos[0]["content"].as_str(), Some("Plan the work"));
    assert_eq!(todos[0]["status"].as_str(), Some("completed"));
    assert_eq!(todos[1]["content"].as_str(), Some("Write tests"));
    assert_eq!(todos[1]["status"].as_str(), Some("pending"));
}

// ---------------------------------------------------------------------------
// R6: prompt_suggestion is on the default suppression list in
// `event_filter::SUPPRESSED_EVENT_TYPES` — verify the noise filter
// drops it before any handler runs.
// ---------------------------------------------------------------------------

#[test]
fn prompt_suggestion_is_dropped_by_default_noise_filter() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    let event = json!({
        "type": "prompt_suggestion",
        "suggestion": "Try cargo test --tests",
    });
    let outcome = acc.push_event(&event, &event.to_string());

    assert_eq!(outcome, PushOutcome::NoOp);
    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 0);
    assert!(acc.dropped_event_types().is_empty());
}

// ---------------------------------------------------------------------------
// R6: rate_limit_event routing — same idea, pin the routing layer.
// ---------------------------------------------------------------------------

#[test]
fn rate_limit_event_routed_into_collected_snapshot() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    let event = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "queued",
            "rateLimitType": "five_hour",
        }
    });
    acc.push_event(&event, &event.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].role, "system");
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    assert_eq!(parsed["type"].as_str(), Some("rate_limit_event"));
    assert_eq!(parsed["rate_limit_info"]["status"].as_str(), Some("queued"));
}

#[test]
fn mark_pending_tools_aborted_flips_claude_live_block() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "tc1", "name": "Write"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": "{\"file_path\":\"/a.txt\"}"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0}
        }),
        "",
    );
    let pre = acc.snapshot("ctx", "sess");
    assert_eq!(
        pre[0].parsed.as_ref().unwrap()["message"]["content"][0]["__streaming_status"].as_str(),
        Some("running"),
    );

    acc.mark_pending_tools_aborted();

    let post = acc.snapshot("ctx", "sess");
    assert_eq!(
        post[0].parsed.as_ref().unwrap()["message"]["content"][0]["__streaming_status"].as_str(),
        Some("error"),
    );
}

#[test]
fn mark_pending_tools_aborted_flips_codex_collected_tool_use() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");
    let started = json!({
        "type": "item/started",
        "itemId": "item1",
        "item": {
            "type": "commandExecution",
            "id": "item1",
            "command": "sleep 60",
        }
    });
    acc.push_event(&started, &started.to_string());

    let collected = acc.collected();
    assert_eq!(collected.len(), 1);
    let pre_block = &collected[0].parsed.as_ref().unwrap()["message"]["content"][0];
    assert_eq!(pre_block["__streaming_status"].as_str(), Some("running"));

    acc.mark_pending_tools_aborted();

    let collected = acc.collected();
    let post_block = &collected[0].parsed.as_ref().unwrap()["message"]["content"][0];
    assert_eq!(post_block["__streaming_status"].as_str(), Some("error"));
    // raw_json must be re-serialized to match parsed for historical reload
    let reparsed: Value = serde_json::from_str(&collected[0].raw_json).unwrap();
    assert_eq!(
        reparsed["message"]["content"][0]["__streaming_status"].as_str(),
        Some("error"),
    );
}

#[test]
fn mark_pending_tools_aborted_no_clobber_when_tool_result_present() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");
    let completed = json!({
        "type": "item/completed",
        "itemId": "item1",
        "item": {
            "type": "commandExecution",
            "id": "item1",
            "command": "ls",
            "exitCode": 0,
            "aggregatedOutput": "file.txt",
        }
    });
    acc.push_event(&completed, &completed.to_string());

    let running = json!({
        "type": "item/started",
        "itemId": "item2",
        "item": {
            "type": "commandExecution",
            "id": "item2",
            "command": "sleep 60",
        }
    });
    acc.push_event(&running, &running.to_string());

    acc.mark_pending_tools_aborted();

    let collected = acc.collected();
    let asst: Vec<&IntermediateMessage> =
        collected.iter().filter(|m| m.role == "assistant").collect();
    assert_eq!(asst.len(), 2);

    let completed_block = &asst[0].parsed.as_ref().unwrap()["message"]["content"][0];
    assert!(completed_block.get("__streaming_status").is_none());

    let running_block = &asst[1].parsed.as_ref().unwrap()["message"]["content"][0];
    assert_eq!(running_block["__streaming_status"].as_str(), Some("error"));
}

#[test]
fn mark_pending_tools_aborted_is_idempotent_and_safe_with_no_pending_work() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    acc.mark_pending_tools_aborted();
    assert_eq!(acc.collected().len(), 0);
    assert!(acc.snapshot("ctx", "sess").is_empty());

    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "tc1", "name": "Read"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0}
        }),
        "",
    );
    acc.mark_pending_tools_aborted();
    let after_first = acc.snapshot("ctx", "sess");
    let status_after_first = after_first[0].parsed.as_ref().unwrap()["message"]["content"][0]
        ["__streaming_status"]
        .as_str()
        .map(str::to_string);
    assert_eq!(status_after_first.as_deref(), Some("error"));

    acc.mark_pending_tools_aborted();
    let after_second = acc.snapshot("ctx", "sess");
    let status_after_second = after_second[0].parsed.as_ref().unwrap()["message"]["content"][0]
        ["__streaming_status"]
        .as_str()
        .map(str::to_string);
    assert_eq!(status_after_second, status_after_first);
}

#[test]
fn abort_end_to_end_contract() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    let started = json!({
        "type": "item/started",
        "itemId": "item1",
        "item": {
            "type": "commandExecution",
            "id": "item1",
            "command": "sleep 60",
        }
    });
    acc.push_event(&started, &started.to_string());

    acc.mark_pending_tools_aborted();
    acc.flush_pending();
    acc.append_aborted_notice();
    let output = acc.drain_output(Some("sess-fallback"));

    let collected = acc.collected();
    let asst_tool_use = collected
        .iter()
        .find(|m| m.role == "assistant")
        .expect("synthetic Codex tool_use missing");
    let block = &asst_tool_use.parsed.as_ref().unwrap()["message"]["content"][0];
    assert_eq!(block["__streaming_status"].as_str(), Some("error"));

    let abort_notice = collected
        .iter()
        .find(|m| m.role == "error")
        .expect("abort notice missing from collected");
    let parsed = abort_notice.parsed.as_ref().unwrap();
    assert_eq!(parsed["type"].as_str(), Some("error"));
    assert_eq!(parsed["content"].as_str(), Some("aborted by user"));

    let found_notice_turn = (0..acc.turns_len()).any(|i| {
        let t = acc.turn_at(i);
        t.role == "error" && t.content_json.contains("aborted by user")
    });
    assert!(found_notice_turn, "abort notice missing from turns[]");

    // No synthetic user-role tool_result rows — we used to push these but
    // they polluted adapter::convert_user_type_msg's lookahead. The
    // adapter settle pass fills ToolCall.result downstream instead.
    let synthetic_user_count = collected
        .iter()
        .filter(|m| m.role == "user" && m.id.starts_with("abort-tr:"))
        .count();
    assert_eq!(synthetic_user_count, 0);

    assert!(output.assistant_text.is_empty());
    assert_eq!(output.session_id.as_deref(), Some("sess-fallback"));
    assert_eq!(output.resolved_model, "gpt-5.4");
}

#[test]
fn drain_output_returns_empty_output_when_no_assistant_text() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.flush_pending();
    let output = acc.drain_output(Some("fallback-sess"));
    assert!(output.assistant_text.is_empty());
    assert!(output.thinking_text.is_none());
    assert_eq!(output.session_id.as_deref(), Some("fallback-sess"));
    assert!(output.result_json.is_none());
}

/// Regression: notice must land in turns[] AFTER the staged Claude
/// assistant turn that flush_pending will push. Historical reload sorts
/// by rowid so the wrong INSERT order surfaces as "aborted by user"
/// floating above the in-progress assistant message it relates to.
#[test]
fn abort_notice_lands_after_flushed_assistant_in_turns() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    let asst = json!({
        "type": "assistant",
        "message": {
            "id": "msg_tool",
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "t1",
                "name": "Bash",
                "input": {"command": "sleep 60"}
            }]
        }
    });
    acc.push_event(&asst, &asst.to_string());

    // Caller's contract: flush BEFORE appending the notice
    acc.mark_pending_tools_aborted();
    acc.flush_pending();
    acc.append_aborted_notice();

    let last = acc.turns_len() - 1;
    let last_turn = acc.turn_at(last);
    assert_eq!(last_turn.role, "error");
    assert!(last_turn.content_json.contains("aborted by user"));

    let prev_turn = acc.turn_at(last - 1);
    assert_eq!(prev_turn.role, "assistant");
    assert!(prev_turn.content_json.contains("Bash"));
}

#[test]
fn materialized_partial_stays_before_abort_notice_in_snapshot() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text"}
            }
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "still streaming"}
            }
        }),
        "",
    );

    acc.mark_pending_tools_aborted();
    acc.flush_pending();
    acc.materialize_partial("ctx", "sess");
    acc.append_aborted_notice();

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 2);
    assert_eq!(snapshot[0].role, "assistant");
    assert_eq!(snapshot[1].role, "error");
    assert!(!snapshot[0].is_streaming);
    assert_eq!(
        snapshot[0].parsed.as_ref().unwrap()["message"]["content"][0]["text"].as_str(),
        Some("still streaming"),
    );
    assert_eq!(
        snapshot[1].parsed.as_ref().unwrap()["content"].as_str(),
        Some("aborted by user"),
    );
}

#[test]
fn append_aborted_notice_appends_one_per_call() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    acc.append_aborted_notice();

    let count_after_one = acc.collected().iter().filter(|m| m.role == "error").count();
    assert_eq!(count_after_one, 1);

    let turns_after_one = (0..acc.turns_len())
        .filter(|&i| acc.turn_at(i).role == "error")
        .count();
    assert_eq!(turns_after_one, 1);
}

// -----------------------------------------------------------------------
// ID unification: sync_persisted_ids / sync_result_id
// -----------------------------------------------------------------------

fn push_assistant_event(acc: &mut StreamAccumulator, msg_id: &str, text: &str) {
    let raw = serde_json::json!({
        "type": "assistant",
        "message": {
            "id": msg_id,
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        }
    });
    let line = serde_json::to_string(&raw).unwrap();
    acc.push_event(&raw, &line);
}

fn push_user_event(acc: &mut StreamAccumulator) {
    let raw = serde_json::json!({
        "type": "user",
        "content": [{"type": "tool_result", "tool_use_id": "t1"}]
    });
    let line = serde_json::to_string(&raw).unwrap();
    acc.push_event(&raw, &line);
}

fn push_result_event(acc: &mut StreamAccumulator) {
    let raw = serde_json::json!({
        "type": "result",
        "result": "Done",
        "usage": {"input_tokens": 10, "output_tokens": 5}
    });
    let line = serde_json::to_string(&raw).unwrap();
    acc.push_event(&raw, &line);
}

#[test]
fn sync_persisted_ids_propagates_turn_uuids_to_collected() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    // assistant turn (msg_id="m1") → collected[0]
    push_assistant_event(&mut acc, "m1", "Hello");
    // user tool result → flushes assistant, creates user turn → collected[1]
    push_user_event(&mut acc);

    assert_eq!(acc.turns_len(), 2);
    let asst_turn_id = acc.turn_at(0).id.clone();
    let user_turn_id = acc.turn_at(1).id.clone();

    // Before sync: collected IDs are ephemeral stream:N:role
    assert!(
        acc.collected()[0].id.starts_with("stream:")
            || acc.collected()[0].id.contains("stream-partial")
    );
    assert!(acc.collected()[1].id.starts_with("stream:"));

    // Sync propagates turn UUIDs
    acc.sync_persisted_ids();
    assert_eq!(acc.collected()[0].id, asst_turn_id);
    assert_eq!(acc.collected()[1].id, user_turn_id);

    // UUIDs are valid v4 format
    assert!(uuid::Uuid::parse_str(&asst_turn_id).is_ok());
    assert!(uuid::Uuid::parse_str(&user_turn_id).is_ok());
}

#[test]
fn sync_result_id_propagates_to_result_collected_entry() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    push_assistant_event(&mut acc, "m1", "Thinking...");
    push_result_event(&mut acc);

    // result is the last collected entry
    let result_idx = acc.collected().len() - 1;
    let old_id = acc.collected()[result_idx].id.clone();
    assert!(old_id.starts_with("stream:"));

    let fake_db_id = "db-result-uuid-123";
    acc.sync_result_id(fake_db_id);
    assert_eq!(acc.collected()[result_idx].id, fake_db_id);
}

#[test]
fn sync_persisted_ids_with_multi_block_assistant() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    // Two assistant events with same msg_id → batched into one turn
    push_assistant_event(&mut acc, "m1", "Part 1");
    push_assistant_event(&mut acc, "m1", "Part 2");

    // Force flush
    acc.flush_pending();

    assert_eq!(acc.turns_len(), 1);
    let turn_id = acc.turn_at(0).id.clone();

    // collected has 2 entries, but the turn maps to the FIRST
    assert_eq!(acc.collected().len(), 2);
    acc.sync_persisted_ids();
    assert_eq!(acc.collected()[0].id, turn_id);
    // Second entry keeps its original ID (collapse will merge them)
    assert_ne!(acc.collected()[1].id, turn_id);
}

#[test]
fn deferred_pause_final_snapshot_uses_persisted_turn_id() {
    let mut acc = StreamAccumulator::new("claude", "opus");

    push_assistant_event(&mut acc, "m1", "Need input before continuing");
    acc.flush_pending();

    assert_eq!(acc.turns_len(), 1);
    let turn_id = acc.turn_at(0).id.clone();
    assert_ne!(acc.collected()[0].id, turn_id);

    acc.sync_persisted_ids();

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].id, turn_id);
    assert!(!snapshot[0].is_streaming);
}

#[test]
fn turn_ids_are_unique_across_turns() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    push_assistant_event(&mut acc, "m1", "Hello");
    push_user_event(&mut acc);
    push_assistant_event(&mut acc, "m2", "World");
    acc.flush_pending();

    let ids: Vec<String> = (0..acc.turns_len())
        .map(|i| acc.turn_at(i).id.clone())
        .collect();
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(ids.len(), unique.len(), "Turn IDs must be unique");
}

// ---------------------------------------------------------------------------
// Codex vs Claude full-render frequency comparison.
//
// These tests quantify the core architectural difference: Codex fires
// `PushOutcome::Finalized` on terminal item events (item/completed,
// turn/completed), while in-progress events (item/started, deltas)
// use `StreamingDelta`, matching Claude's pattern.
// ---------------------------------------------------------------------------

#[test]
fn claude_streaming_uses_mostly_streaming_delta() {
    // Simulate a typical Claude turn: text streaming + tool_use + result.
    let mut acc = StreamAccumulator::new("claude", "opus");
    let mut finalized_count = 0u32;
    let mut streaming_delta_count = 0u32;

    // 1. Text block start
    let outcome = acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text"}
            }
        }),
        "",
    );
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 2. Multiple text deltas (simulate 10 streaming chunks)
    for i in 0..10 {
        let outcome = acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": format!("chunk{i} ")}
                }
            }),
            "",
        );
        match outcome {
            PushOutcome::Finalized => finalized_count += 1,
            PushOutcome::StreamingDelta => streaming_delta_count += 1,
            _ => {}
        }
    }

    // 3. Text block stop
    let outcome = acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 0}
        }),
        "",
    );
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 4. Tool use block
    let outcome = acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": {"type": "tool_use", "id": "tc1", "name": "Bash"}
            }
        }),
        "",
    );
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    let outcome = acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": "{\"command\":\"ls\"}"}
            }
        }),
        "",
    );
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    let outcome = acc.push_event(
        &json!({
            "type": "stream_event",
            "event": {"type": "content_block_stop", "index": 1}
        }),
        "",
    );
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 5. Full assistant message (terminal)
    let full_msg = json!({
        "type": "assistant",
        "message": {
            "id": "msg1",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "chunk0 chunk1 chunk2 chunk3 chunk4 chunk5 chunk6 chunk7 chunk8 chunk9 "},
                {"type": "tool_use", "id": "tc1", "name": "Bash", "input": {"command": "ls"}}
            ]
        }
    });
    let raw = serde_json::to_string(&full_msg).unwrap();
    let outcome = acc.push_event(&full_msg, &raw);
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // Claude: overwhelming majority are StreamingDelta, only 1 Finalized
    // (the terminal assistant message).
    assert!(
        streaming_delta_count > finalized_count,
        "Claude should use StreamingDelta far more than Finalized. \
         Got streaming_delta={streaming_delta_count}, finalized={finalized_count}"
    );
    assert_eq!(
        finalized_count, 1,
        "Claude should have exactly 1 Finalized (the terminal assistant message)"
    );
}

#[test]
fn codex_streaming_fires_finalized_on_every_event() {
    // Simulate a typical Codex turn with the same logical operations:
    // text analysis + command execution with full lifecycle.
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");
    let mut finalized_count = 0u32;
    let mut streaming_delta_count = 0u32;

    // 1. agent_message item/started
    let event = json!({
        "type": "item/started",
        "itemId": "msg1",
        "item": {"type": "agentMessage", "id": "msg1", "text": ""}
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 2. agent_message delta (replaces item.updated)
    let event = json!({
        "type": "item/agentMessage/delta",
        "itemId": "msg1",
        "delta": "Let me analyze..."
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 3. agent_message item/completed
    let event = json!({
        "type": "item/completed",
        "itemId": "msg1",
        "item": {"type": "agentMessage", "id": "msg1", "text": "Let me analyze the codebase."}
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 4. command_execution item/started
    let event = json!({
        "type": "item/started",
        "itemId": "cmd1",
        "item": {"type": "commandExecution", "id": "cmd1", "command": "ls -la"}
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 5. command_execution item/completed
    let event = json!({
        "type": "item/completed",
        "itemId": "cmd1",
        "item": {
            "type": "commandExecution",
            "id": "cmd1",
            "command": "ls -la",
            "exitCode": 0,
            "aggregatedOutput": "file1.txt\nfile2.txt"
        }
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 6. Second agent_message item/started
    let event = json!({
        "type": "item/started",
        "itemId": "msg2",
        "item": {"type": "agentMessage", "id": "msg2", "text": ""}
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 7. Second agent_message item/completed
    let event = json!({
        "type": "item/completed",
        "itemId": "msg2",
        "item": {"type": "agentMessage", "id": "msg2", "text": "The directory contains two files."}
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 8. turn/completed
    let event = json!({"type": "turn/completed", "turn": {"id": "t1", "status": "completed"}});
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // item/started and item/agentMessage/delta use StreamingDelta,
    // only item/completed and turn/completed use Finalized.
    // Events: started(msg1)=SD, delta(msg1)=SD, completed(msg1)=F,
    //         started(cmd1)=SD, completed(cmd1)=F,
    //         started(msg2)=SD, completed(msg2)=F, turn/completed=F
    assert_eq!(
        streaming_delta_count, 4,
        "item/started and delta events should be StreamingDelta"
    );
    assert_eq!(
        finalized_count, 4,
        "Only item/completed and turn/completed should be Finalized"
    );
}

/// Verify that item/started and delta events return StreamingDelta
/// while item/completed stays Finalized, matching Claude's pattern.
#[test]
fn codex_fixed_uses_streaming_delta_for_in_progress_items() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");
    let mut finalized_count = 0u32;
    let mut streaming_delta_count = 0u32;

    // item/started -> StreamingDelta
    let event = json!({
        "type": "item/started",
        "itemId": "cmd1",
        "item": {"type": "commandExecution", "id": "cmd1", "command": "ls"}
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // output delta -> StreamingDelta (replaces item.updated)
    let event = json!({
        "type": "item/commandExecution/outputDelta",
        "itemId": "cmd1",
        "delta": "file.txt\n"
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // item/completed -> Finalized (terminal event, like Claude's assistant)
    let event = json!({
        "type": "item/completed",
        "itemId": "cmd1",
        "item": {
            "type": "commandExecution",
            "id": "cmd1",
            "command": "ls",
            "exitCode": 0,
            "aggregatedOutput": "file.txt"
        }
    });
    let outcome = acc.push_event(&event, &event.to_string());
    match outcome {
        PushOutcome::Finalized => finalized_count += 1,
        PushOutcome::StreamingDelta => streaming_delta_count += 1,
        _ => {}
    }

    // 2 StreamingDelta + 1 Finalized
    // (matching Claude's pattern: deltas are light, only terminal is full)
    assert_eq!(
        streaming_delta_count, 2,
        "item/started and delta events should be StreamingDelta"
    );
    assert_eq!(
        finalized_count, 1,
        "Only item/completed should be Finalized"
    );
}

// ---------------------------------------------------------------------------
// Codex delta-based accumulation — item/started → deltas → item/completed
// ---------------------------------------------------------------------------

#[test]
fn codex_text_delta_accumulates_into_agent_message() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    // item/started
    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "msg1",
            "item": {"type": "agentMessage", "id": "msg1"}
        }),
        "",
    );

    // text deltas
    acc.push_event(
        &json!({
            "type": "item/agentMessage/delta",
            "itemId": "msg1",
            "text": "Hello "
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "item/agentMessage/delta",
            "itemId": "msg1",
            "text": "world"
        }),
        "",
    );

    // Mid-stream snapshot should show accumulated text
    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    let item = &parsed["item"];
    assert_eq!(item["type"].as_str(), Some("agent_message"));
    assert_eq!(item["text"].as_str(), Some("Hello world"));
}

#[test]
fn codex_command_output_delta_accumulates() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "cmd1",
            "item": {"type": "commandExecution", "id": "cmd1", "command": "ls -la"}
        }),
        "",
    );

    acc.push_event(
        &json!({
            "type": "item/commandExecution/outputDelta",
            "itemId": "cmd1",
            "output": "file1.txt\n"
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "item/commandExecution/outputDelta",
            "itemId": "cmd1",
            "output": "file2.txt\n"
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    // Should have a synthetic Bash tool_use in the snapshot
    assert!(!snapshot.is_empty());
    let asst = snapshot.iter().find(|m| m.role == "assistant").unwrap();
    let block = &asst.parsed.as_ref().unwrap()["message"]["content"][0];
    assert_eq!(block["name"].as_str(), Some("Bash"));
    assert_eq!(block["input"]["command"].as_str(), Some("ls -la"));
}

#[test]
fn codex_reasoning_delta_accumulates() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "r1",
            "item": {"type": "reasoning", "id": "r1"}
        }),
        "",
    );

    acc.push_event(
        &json!({
            "type": "item/reasoning/textDelta",
            "itemId": "r1",
            "text": "Let me think "
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "item/reasoning/textDelta",
            "itemId": "r1",
            "text": "about this..."
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    let thinking = &parsed["message"]["content"][0];
    assert_eq!(thinking["type"].as_str(), Some("thinking"));
    assert_eq!(
        thinking["thinking"].as_str(),
        Some("Let me think about this...")
    );
}

#[test]
fn codex_plan_delta_accumulates() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "plan1",
            "item": {"type": "plan", "id": "plan1"}
        }),
        "",
    );

    acc.push_event(
        &json!({
            "type": "item/plan/delta",
            "itemId": "plan1",
            "delta": "Step 1: Read files\n"
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "item/plan/delta",
            "itemId": "plan1",
            "delta": "Step 2: Write tests"
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    let item = &parsed["item"];
    assert_eq!(item["type"].as_str(), Some("plan"));
    assert_eq!(
        item["text"].as_str(),
        Some("Step 1: Read files\nStep 2: Write tests")
    );
}

#[test]
fn codex_item_completed_clears_delta_state() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    // Start and accumulate
    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "msg1",
            "item": {"type": "agentMessage", "id": "msg1"}
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "item/agentMessage/delta",
            "itemId": "msg1",
            "text": "Hello"
        }),
        "",
    );

    // Complete — should clear delta state for this item
    let completed = json!({
        "type": "item/completed",
        "itemId": "msg1",
        "item": {"type": "agentMessage", "id": "msg1", "text": "Hello world"}
    });
    acc.push_event(&completed, &completed.to_string());

    // Should persist a turn
    assert!(acc.turns_len() > 0);
    let turn = acc.turn_at(acc.turns_len() - 1);
    assert_eq!(turn.role, "assistant");
}

#[test]
fn codex_turn_completed_extracts_usage_tokens() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    // Push a message first
    let msg = json!({
        "type": "item/completed",
        "itemId": "msg1",
        "item": {"type": "agentMessage", "id": "msg1", "text": "Done"}
    });
    acc.push_event(&msg, &msg.to_string());

    // turn/completed with usage
    let turn = json!({
        "type": "turn/completed",
        "turn": {"id": "t1", "status": "completed"},
        "usage": {"input_tokens": 1500, "output_tokens": 300}
    });
    acc.push_event(&turn, &turn.to_string());

    let output = acc.drain_output(Some("sess"));
    assert_eq!(output.usage.input_tokens, Some(1500));
    assert_eq!(output.usage.output_tokens, Some(300));
}

#[test]
fn codex_turn_failed_produces_error_message() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    let event = json!({
        "type": "turn/completed",
        "turn": {
            "id": "t1",
            "status": "failed",
            "error": {"message": "Rate limit exceeded"}
        }
    });
    acc.push_event(&event, &event.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    assert!(!snapshot.is_empty());
    let err = snapshot.iter().find(|m| m.role == "error").unwrap();
    let parsed = err.parsed.as_ref().unwrap();
    assert_eq!(parsed["type"].as_str(), Some("error"));
    assert_eq!(parsed["message"].as_str(), Some("Rate limit exceeded"));
}

#[test]
fn codex_normalize_camel_case_item_types() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    // Push camelCase items and verify they're normalized
    let event = json!({
        "type": "item/completed",
        "itemId": "cmd1",
        "item": {
            "type": "commandExecution",
            "id": "cmd1",
            "command": "echo hi",
            "exitCode": 0,
            "aggregatedOutput": "hi"
        }
    });
    acc.push_event(&event, &event.to_string());

    // The persisted turn should have snake_case fields
    assert!(acc.turns_len() > 0);
    let turn = acc.turn_at(acc.turns_len() - 1);
    let parsed: Value = serde_json::from_str(&turn.content_json).unwrap();
    let item = &parsed["item"];
    assert_eq!(item["type"].as_str(), Some("command_execution"));
    assert_eq!(item["exit_code"].as_i64(), Some(0));
    assert_eq!(item["aggregated_output"].as_str(), Some("hi"));
}

#[test]
fn codex_flush_in_progress_drains_delta_items() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    // Start items but don't complete them
    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "msg1",
            "item": {"type": "agentMessage", "id": "msg1"}
        }),
        "",
    );
    acc.push_event(
        &json!({
            "type": "item/agentMessage/delta",
            "itemId": "msg1",
            "text": "Partial text"
        }),
        "",
    );

    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "cmd1",
            "item": {"type": "commandExecution", "id": "cmd1", "command": "sleep 60"}
        }),
        "",
    );

    let turns_before = acc.turns_len();

    // flush_in_progress should drain both items
    super::codex::flush_in_progress(&mut acc);

    // Should have persisted turns for both items
    assert!(acc.turns_len() > turns_before);
}

#[test]
fn codex_turn_plan_updated_maps_to_todo_list() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    let event = json!({
        "type": "turn/plan/updated",
        "turnId": "turn-1",
        "plan": [
            {"step": "Read the codebase", "status": "completed"},
            {"step": "Write tests", "status": "inProgress"},
            {"step": "Fix bugs", "status": "pending"},
        ]
    });
    acc.push_event(&event, &event.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    let block = &parsed["message"]["content"][0];
    assert_eq!(block["name"].as_str(), Some("TodoWrite"));
    let todos = block["input"]["todos"].as_array().unwrap();
    assert_eq!(todos.len(), 3);
    assert_eq!(todos[0]["status"].as_str(), Some("completed"));
    assert_eq!(todos[1]["status"].as_str(), Some("in_progress"));
    assert_eq!(todos[2]["status"].as_str(), Some("pending"));
}

#[test]
fn codex_web_search_item_lifecycle() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    // item/started
    acc.push_event(
        &json!({
            "type": "item/started",
            "itemId": "ws1",
            "item": {"type": "webSearch", "id": "ws1", "query": "rust testing"}
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    let asst = snapshot.iter().find(|m| m.role == "assistant").unwrap();
    let block = &asst.parsed.as_ref().unwrap()["message"]["content"][0];
    assert_eq!(block["name"].as_str(), Some("WebSearch"));
    assert_eq!(block["__streaming_status"].as_str(), Some("running"));

    // item/completed
    let completed = json!({
        "type": "item/completed",
        "itemId": "ws1",
        "item": {"type": "webSearch", "id": "ws1", "query": "rust testing"}
    });
    acc.push_event(&completed, &completed.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    // Should have assistant (tool_use) + user (tool_result)
    let user = snapshot.iter().find(|m| m.role == "user");
    assert!(user.is_some(), "Should have search result");
}

#[test]
fn codex_mcp_tool_call_item_lifecycle() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    let started = json!({
        "type": "item/started",
        "itemId": "mcp1",
        "item": {
            "type": "mcpToolCall",
            "id": "mcp1",
            "server": "context7",
            "tool": "query-docs",
            "arguments": {"query": "React hooks"},
            "status": "inProgress"
        }
    });
    acc.push_event(&started, &started.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    let asst = snapshot.iter().find(|m| m.role == "assistant").unwrap();
    let block = &asst.parsed.as_ref().unwrap()["message"]["content"][0];
    assert_eq!(block["name"].as_str(), Some("mcp__context7__query-docs"));
    assert_eq!(block["__streaming_status"].as_str(), Some("running"));

    let completed = json!({
        "type": "item/completed",
        "itemId": "mcp1",
        "item": {
            "type": "mcpToolCall",
            "id": "mcp1",
            "server": "context7",
            "tool": "query-docs",
            "arguments": {"query": "React hooks"},
            "status": "completed",
            "result": {"docs": "..."}
        }
    });
    acc.push_event(&completed, &completed.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    let user = snapshot.iter().find(|m| m.role == "user");
    assert!(user.is_some(), "Should have MCP tool result");
}

#[test]
fn codex_error_item_produces_error_message() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    let event = json!({
        "type": "item/completed",
        "itemId": "err1",
        "item": {
            "type": "error",
            "id": "err1",
            "message": "API key expired"
        }
    });
    acc.push_event(&event, &event.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    let err = snapshot.iter().find(|m| m.role == "error").unwrap();
    let parsed = err.parsed.as_ref().unwrap();
    assert_eq!(parsed["message"].as_str(), Some("API key expired"));
}

#[test]
fn codex_delta_for_unknown_item_id_is_ignored() {
    let mut acc = StreamAccumulator::new("codex", "gpt-5.4");

    // Delta for an item that was never started — should not panic
    acc.push_event(
        &json!({
            "type": "item/agentMessage/delta",
            "itemId": "ghost",
            "text": "orphan delta"
        }),
        "",
    );

    let snapshot = acc.snapshot("ctx", "sess");
    assert!(snapshot.is_empty(), "Orphan delta should be ignored");
}
