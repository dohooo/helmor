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
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "command": "ls -la",
            "output": "file1.txt\nfile2.txt",
            "exit_code": 0
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

/// Regression for the "final assistant turn lost on stream end" bug.
///
/// `handle_assistant` does NOT push to `self.turns` directly — it stages
/// the message into `cur_asst_*` and only flushes when (a) the next
/// assistant has a different msg_id, (b) a user/tool_result event
/// arrives, or (c) `flush_assistant` is called explicitly.
///
/// In a typical Claude session the **final** assistant turn never hits
/// any of those triggers — it's followed by a `result` event and then
/// the stream `end`. Until this fix, agents.rs read `turns_len()`
/// BEFORE calling `finish_output(mut self)`, so the staged final
/// assistant turn was missed; the subsequent `flush_assistant` inside
/// `finish_output` happened on a `self` that was about to be consumed,
/// so the freshly-pushed turn was unreachable to the persistence loop.
///
/// This test pins the contract that finish_output makes the final
/// assistant turn observable on the still-alive accumulator.
#[test]
fn finish_output_flushes_final_assistant_into_turns() {
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

    // The fix: finish_output must flush the staged turn AND leave the
    // accumulator alive so the caller can read it.
    let output = acc
        .finish_output(Some("sess-xyz"))
        .expect("finish_output should succeed");

    // Post-finalize: the staged turn is now in self.turns, observable
    // on the SAME accumulator instance the caller still owns.
    assert_eq!(
        acc.turns_len(),
        3,
        "finish_output should flush the staged final assistant into self.turns"
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

    // finish_output flushes msg_B into turns.
    acc.finish_output(None).unwrap();
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
        "type": "item.completed",
        "item": {
            "type": "todo_list",
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
// R6: prompt_suggestion routing — verify that a top-level
// prompt_suggestion event lands in the snapshot as a system-role
// intermediate so the adapter can render it.
// ---------------------------------------------------------------------------

#[test]
fn prompt_suggestion_routed_into_collected_snapshot() {
    let mut acc = StreamAccumulator::new("claude", "opus");
    let event = json!({
        "type": "prompt_suggestion",
        "suggestion": "Try cargo test --tests",
    });
    acc.push_event(&event, &event.to_string());

    let snapshot = acc.snapshot("ctx", "sess");
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].role, "system");
    let parsed = snapshot[0].parsed.as_ref().unwrap();
    assert_eq!(parsed["type"].as_str(), Some("prompt_suggestion"));
    assert_eq!(
        parsed["suggestion"].as_str(),
        Some("Try cargo test --tests")
    );
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
