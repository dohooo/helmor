//! Builders — produce `HistoricalRecord` with `parsed_content` auto-derived
//! from `content`. Mirrors the production loader in
//! `sessions.rs::list_session_*`.

use helmor_lib::pipeline::types::HistoricalRecord;
use helmor_lib::pipeline::MessagePipeline;
use serde_json::{json, Value};

use super::normalize::{normalize_all, NormThreadMessage};

pub fn make_record(id: &str, role: &str, content: &str) -> HistoricalRecord {
    HistoricalRecord {
        id: id.to_string(),
        role: role.parse().expect("valid role"),
        content: content.to_string(),
        parsed_content: serde_json::from_str::<Value>(content).ok(),
        created_at: "2026-04-06T00:00:00.000Z".to_string(),
    }
}

pub fn assistant_json(id: &str, blocks: Value, extra: Option<Value>) -> HistoricalRecord {
    let mut parsed = json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": blocks },
    });
    if let Some(e) = extra {
        if let Some(obj) = e.as_object() {
            for (k, v) in obj {
                parsed[k] = v.clone();
            }
        }
    }
    make_record(id, "assistant", &serde_json::to_string(&parsed).unwrap())
}

pub fn user_json(id: &str, blocks: Value) -> HistoricalRecord {
    let parsed = json!({
        "type": "user",
        "message": { "role": "user", "content": blocks },
    });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

/// Post-migration form for real human prompts:
/// `{"type":"user_prompt","text":"..."}`
pub fn user_prompt(id: &str, text: &str) -> HistoricalRecord {
    let parsed = json!({ "type": "user_prompt", "text": text });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

/// Post-migration user prompt with @-mention file paths attached.
pub fn user_prompt_with_files(id: &str, text: &str, files: &[&str]) -> HistoricalRecord {
    let parsed = json!({
        "type": "user_prompt",
        "text": text,
        "files": files,
    });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

/// Post-migration user prompt with structured file AND image
/// attachment paths.
pub fn user_prompt_with_files_and_images(
    id: &str,
    text: &str,
    files: &[&str],
    images: &[&str],
) -> HistoricalRecord {
    let parsed = json!({
        "type": "user_prompt",
        "text": text,
        "files": files,
        "images": images,
    });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

/// Mid-turn steer prompt. Same shape as `user_prompt` but with the
/// `steer: true` marker written by `persist_steer_message`.
pub fn user_prompt_steer(id: &str, text: &str) -> HistoricalRecord {
    let parsed = json!({
        "type": "user_prompt",
        "text": text,
        "steer": true,
    });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

/// Mid-turn steer prompt with structured file AND image attachment
/// paths. Mirrors what the sidecar's synthetic `user_prompt` event
/// emits when the user steers with attachments — we keep both arrays
/// so the persisted DB row matches the optimistic render and image
/// badges survive a reload.
pub fn user_prompt_steer_with_files_and_images(
    id: &str,
    text: &str,
    files: &[&str],
    images: &[&str],
) -> HistoricalRecord {
    let parsed = json!({
        "type": "user_prompt",
        "text": text,
        "steer": true,
        "files": files,
        "images": images,
    });
    make_record(id, "user", &serde_json::to_string(&parsed).unwrap())
}

pub fn exit_plan_mode(
    id: &str,
    tool_use_id: &str,
    plan: &str,
    plan_file_path: Option<&str>,
    allowed_prompts: &[(&str, &str)],
) -> HistoricalRecord {
    let mut parsed = json!({
        "type": "exit_plan_mode",
        "toolUseId": tool_use_id,
        "toolName": "ExitPlanMode",
        "plan": plan,
    });
    if let Some(path) = plan_file_path {
        parsed["planFilePath"] = Value::String(path.to_string());
    }
    if !allowed_prompts.is_empty() {
        parsed["allowedPrompts"] = Value::Array(
            allowed_prompts
                .iter()
                .map(|(tool, prompt)| json!({ "tool": tool, "prompt": prompt }))
                .collect(),
        );
    }
    make_record(id, "assistant", &serde_json::to_string(&parsed).unwrap())
}

pub fn system_json(id: &str, extra: Value) -> HistoricalRecord {
    let mut parsed = json!({ "type": "system" });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            parsed[k] = v.clone();
        }
    }
    make_record(id, "system", &serde_json::to_string(&parsed).unwrap())
}

pub fn result_json(id: &str, extra: Value) -> HistoricalRecord {
    let mut parsed = json!({ "type": "result" });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            parsed[k] = v.clone();
        }
    }
    make_record(id, "assistant", &serde_json::to_string(&parsed).unwrap())
}

/// Run records through the pipeline and return the normalized form. Used by
/// the handcrafted scenarios where structural shape is what matters.
pub fn run_normalized(msgs: Vec<HistoricalRecord>) -> Vec<NormThreadMessage> {
    normalize_all(&MessagePipeline::convert_historical(&msgs))
}
