//! Handcrafted scenario tests for the message pipeline.
//!
//! Each test feeds a small (1-3 record) scenario into
//! `MessagePipeline::convert_historical` and freezes the resulting
//! `Vec<ThreadMessageLike>` via `insta::assert_yaml_snapshot!`. The output
//! goes through a normalization pass (`common::run_normalized`) that strips
//! timestamps, lowercases the role enum, truncates long strings, and reports
//! tool-call args as sorted key sets — making each snapshot short enough to
//! review in a diff while still pinning behaviorally significant edge cases.
//!
//! # Coverage by category
//!
//! - `err_*`   — error message normalization (5)
//! - `user_*`  — user message edge cases (8, including 3 user_prompt-shape tests)
//! - `res_*`   — result message duration / token formatting (6)
//! - `edge_*`  — empty/100-alternating/unknown-type/non-json (8)
//! - `asst_*`  — selected assistant variants (5)
//! - `sys_*`   — system message rendering (2)
//! - `merge_*` — merging boundaries (2)
//!
//! Real-data fixtures (full DB sessions) live in `pipeline_fixtures.rs`.
//! Raw stream-event jsonl replay lives in `pipeline_streams.rs`.
//!
//! # Updating snapshots
//!
//! ```sh
//! INSTA_UPDATE=always cargo test --test pipeline_scenarios
//! # or, with the insta CLI:
//! cargo insta review
//! ```

mod common;

use common::*;
use insta::assert_yaml_snapshot;
use serde::Serialize;
use serde_json::json;

// ============================================================================
// 1. Error messages
// ============================================================================

#[test]
fn err_content_string() {
    let parsed = json!({ "type": "error", "content": "Something broke" });
    let msgs = vec![make_record(
        "e1",
        "error",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn err_message_string() {
    let parsed = json!({ "type": "error", "message": "Boom" });
    let msgs = vec![make_record(
        "e1",
        "error",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn err_role_plain_text() {
    let msgs = vec![make_record("e1", "error", "crash!")];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn err_raw_json_content() {
    let raw = serde_json::to_string(&json!({ "content": "inner error" })).unwrap();
    let msgs = vec![make_record("e1", "error", &raw)];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn err_empty() {
    let parsed = json!({ "type": "error" });
    let msgs = vec![make_record(
        "e1",
        "error",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

// ============================================================================
// 2. User messages
// ============================================================================

#[test]
fn user_plain_text() {
    // Legacy / unmigrated row form. After the user_prompt migration the
    // production write path uses `user_prompt(...)` instead, but the loader
    // still tolerates a corrupted row by leaving parsed_content = None.
    let msgs = vec![make_record("u1", "user", "hello assistant")];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn user_prompt_wrapped() {
    // Post-migration form: real human prompt wrapped as
    // {"type":"user_prompt","text":"..."}.
    let msgs = vec![user_prompt("u1", "hello assistant")];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn user_prompt_with_brace_content() {
    // Latent-bug regression: prompts that happened to start with `{` were
    // mis-rendered as system "Event" because the sniff classified them as
    // JSON but they had no `type` field. After wrapping, the literal text
    // is preserved verbatim inside `text`.
    let msgs = vec![user_prompt("u1", r#"{"foo":"bar"}"#)];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn user_json_text_swallowed() {
    // JSON user message with pure text content is dropped (the assistant
    // already has the prompt; this avoids double-rendering).
    let msgs = vec![user_json(
        "u1",
        json!([{ "type": "text", "text": "please do X" }]),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn user_tool_result_only_no_prev() {
    let msgs = vec![user_json(
        "u1",
        json!([{ "type": "tool_result", "tool_use_id": "tX", "content": "out" }]),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn user_mixed_text_and_tool_result() {
    let msgs = vec![user_json(
        "u1",
        json!([
            { "type": "text", "text": "note" },
            { "type": "tool_result", "tool_use_id": "tX", "content": "out" }
        ]),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn user_multi_plain_text() {
    let msgs = vec![
        make_record("u1", "user", "first"),
        make_record("u2", "user", "second"),
    ];
    assert_yaml_snapshot!(run_normalized(msgs));
}

// ============================================================================
// 3. Result messages
// ============================================================================

#[test]
fn res_full() {
    let msgs = vec![result_json(
        "r1",
        json!({
            "total_cost_usd": 0.0123,
            "duration_ms": 4500,
            "usage": { "input_tokens": 1234, "output_tokens": 567 }
        }),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn res_duration_only() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 1500 }))];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn res_duration_long() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 125_000 }))];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn res_duration_exact_60s() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 60_000 }))];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn res_duration_short() {
    let msgs = vec![result_json("r1", json!({ "duration_ms": 3456 }))];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn res_large_tokens() {
    let msgs = vec![result_json(
        "r1",
        json!({
            "duration_ms": 2000,
            "usage": { "input_tokens": 1_234_567, "output_tokens": 98_765 }
        }),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

// ============================================================================
// 4. Edge cases
// ============================================================================

#[test]
fn edge_empty_array() {
    assert_yaml_snapshot!(run_normalized(vec![]));
}

#[test]
fn edge_single_assistant_text() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "text", "text": "hi" }]),
        None,
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn edge_100_alternating() {
    let mut msgs: Vec<HistoricalRecord> = Vec::new();
    for i in 0..100 {
        if i % 2 == 0 {
            msgs.push(user_prompt(&format!("u{i}"), &format!("msg {i}")));
        } else {
            msgs.push(assistant_json(
                &format!("a{i}"),
                json!([{ "type": "text", "text": format!("reply {i}") }]),
                None,
            ));
        }
    }
    let rendered = MessagePipeline::convert_historical(&msgs);

    // High-level structural summary instead of the full normalized form —
    // the bulk content isn't interesting, the shape is.
    #[derive(Serialize)]
    struct Summary {
        total: usize,
        roles: Vec<String>,
        first_id: Option<String>,
        last_id: Option<String>,
    }
    let summary = Summary {
        total: rendered.len(),
        roles: rendered.iter().map(|m| role_str(&m.role)).collect(),
        first_id: rendered.first().and_then(|m| m.id.clone()),
        last_id: rendered.last().and_then(|m| m.id.clone()),
    };
    assert_yaml_snapshot!(summary);
}

#[test]
fn edge_unknown_type() {
    let parsed = json!({ "type": "mystery_event", "whatever": 1 });
    let msgs = vec![make_record(
        "x1",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn edge_no_type_no_role_match() {
    let parsed = json!({ "foo": "bar" });
    let msgs = vec![make_record(
        "x1",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn edge_non_json_assistant_fallback() {
    // Legacy / corrupted row: assistant role with non-JSON content. The
    // production write path always serializes assistant turns as JSON, but
    // the loader still tolerates this case by falling back to plain text.
    let msgs = vec![make_record("a1", "assistant", "plain-text streaming")];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn edge_streaming_flag() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "text", "text": "streaming..." }]),
        Some(json!({ "__streaming": true })),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn edge_non_json_content_with_malformed_json() {
    // Content looks like JSON but isn't parseable → parsed_content stays
    // None and the adapter falls back to the plain-text rendering path.
    let msgs = vec![make_record("a1", "assistant", "{not really json")];
    assert_yaml_snapshot!(run_normalized(msgs));
}

// ============================================================================
// 5. Selected assistant variants
// ============================================================================

#[test]
fn asst_redacted_thinking() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "redacted_thinking", "data": "xxx" }]),
        None,
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn asst_server_tool_use() {
    let msgs = vec![assistant_json(
        "a1",
        json!([{ "type": "server_tool_use", "id": "st1", "name": "WebSearch", "input": { "query": "foo" } }]),
        None,
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn asst_tool_use_missing_id_name() {
    let msgs = vec![assistant_json(
        "a1",
        json!([
            { "type": "tool_use", "input": { "x": 1 } },
            { "type": "tool_use", "input": { "y": 2 } }
        ]),
        None,
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn asst_merge_tool_result_with_image_block() {
    // Image blocks must NOT break the all-tool-result detection — merge still succeeds.
    let msgs = vec![
        assistant_json(
            "a1",
            json!([{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }]),
            None,
        ),
        user_json(
            "u1",
            json!([
                { "type": "tool_result", "tool_use_id": "t1", "content": "file-a" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "xxx" } }
            ]),
        ),
    ];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn asst_empty_content_fallback() {
    // assistant message with empty JSON content array + text fallback field
    let parsed = json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": [] },
        "text": "fallback text"
    });
    let msgs = vec![make_record(
        "a1",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

// ============================================================================
// 6. System messages
// ============================================================================

#[test]
fn sys_error_max_turns_rendered() {
    let msgs = vec![system_json("s1", json!({ "subtype": "error_max_turns" }))];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn sys_no_subtype() {
    let msgs = vec![system_json("s1", json!({}))];
    assert_yaml_snapshot!(run_normalized(msgs));
}

// ============================================================================
// 7. Merge boundaries
// ============================================================================

#[test]
fn merge_broken_by_real_user() {
    let msgs = vec![
        assistant_json("a1", json!([{ "type": "text", "text": "hello" }]), None),
        user_prompt("u1", "more please"),
        assistant_json("a2", json!([{ "type": "text", "text": "world" }]), None),
    ];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn merge_streaming_flag_from_latest() {
    // Latest assistant sets streaming; earlier one does not — merged result
    // must reflect the latest streaming flag only.
    let msgs = vec![
        assistant_json("a1", json!([{ "type": "text", "text": "done" }]), None),
        assistant_json(
            "a2",
            json!([{ "type": "text", "text": "streaming..." }]),
            Some(json!({ "__streaming": true })),
        ),
    ];
    assert_yaml_snapshot!(run_normalized(msgs));
}

// ============================================================================
// 8. Codex item.completed historical loading
// ============================================================================
//
// The Codex SDK persists each `item.completed` event as its own DB row.
// item.type=agent_message → assistant text, item.type=command_execution →
// Bash tool call. Both must render in the historical-load path. Before
// 2026-04-08 the adapter only handled agent_message — every command_execution
// row got silently dropped on reload, leaving the user with a wall of text
// and no visible tool calls.

#[test]
fn codex_item_command_execution_renders_as_bash_tool_call() {
    let parsed = json!({
        "type": "item.completed",
        "item": {
            "id": "item_1",
            "type": "command_execution",
            "command": "ls -la",
            "aggregated_output": "total 4\n.\n..\nREADME.md",
            "status": "completed",
            "exit_code": 0
        }
    });
    let msgs = vec![make_record(
        "c1",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn codex_item_command_execution_failed_includes_exit_code() {
    let parsed = json!({
        "type": "item.completed",
        "item": {
            "id": "item_2",
            "type": "command_execution",
            "command": "false",
            "aggregated_output": "stderr line",
            "status": "failed",
            "exit_code": 1
        }
    });
    let msgs = vec![make_record(
        "c2",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn codex_item_command_execution_legacy_output_field() {
    // Older fixtures (and possibly older SDK builds) used `output` instead
    // of `aggregated_output`. Both must work — pin the fallback so a future
    // cleanup doesn't accidentally drop the legacy reader.
    let parsed = json!({
        "type": "item.completed",
        "item": {
            "id": "item_3",
            "type": "command_execution",
            "command": "echo hello",
            "output": "hello",
            "exit_code": 0
        }
    });
    let msgs = vec![make_record(
        "c3",
        "assistant",
        &serde_json::to_string(&parsed).unwrap(),
    )];
    assert_yaml_snapshot!(run_normalized(msgs));
}

#[test]
fn codex_item_completed_full_session_with_text_and_commands() {
    // Realistic Codex session pattern: text → command → text. The middle
    // command_execution must NOT be dropped (the original bug); the merge
    // pass should fold all three into a single assistant turn with three
    // content parts in the original order.
    let agent_message_1 = json!({
        "type": "item.completed",
        "item": {
            "id": "item_0",
            "type": "agent_message",
            "text": "Let me check the directory."
        }
    });
    let command = json!({
        "type": "item.completed",
        "item": {
            "id": "item_1",
            "type": "command_execution",
            "command": "ls",
            "aggregated_output": "README.md",
            "status": "completed",
            "exit_code": 0
        }
    });
    let agent_message_2 = json!({
        "type": "item.completed",
        "item": {
            "id": "item_2",
            "type": "agent_message",
            "text": "There's only README.md."
        }
    });
    let msgs = vec![
        make_record(
            "c1",
            "assistant",
            &serde_json::to_string(&agent_message_1).unwrap(),
        ),
        make_record("c2", "assistant", &serde_json::to_string(&command).unwrap()),
        make_record(
            "c3",
            "assistant",
            &serde_json::to_string(&agent_message_2).unwrap(),
        ),
    ];
    assert_yaml_snapshot!(run_normalized(msgs));
}
