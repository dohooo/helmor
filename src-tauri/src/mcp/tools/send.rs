use anyhow::Result;
use serde_json::Value;

use crate::agents::AgentStreamEvent;
use crate::pipeline::types::{ExtendedMessagePart, MessagePart};
use crate::service;

use super::super::response::{is_compact_response, truncate_text};
use super::common::required_str;

pub(super) fn tool_send(args: &Value) -> Result<String> {
    let ws_ref = required_str(args, "workspace")?;
    let prompt = required_str(args, "prompt")?;
    let model = args["model"].as_str().map(String::from);
    let session_id = args["session_id"].as_str().map(String::from);
    let permission_mode = if args["plan"].as_bool().unwrap_or(false) {
        Some("plan".to_string())
    } else {
        Some("auto".to_string())
    };

    let params = service::SendMessageParams {
        workspace_ref: ws_ref.to_string(),
        session_id,
        prompt: prompt.to_string(),
        model,
        permission_mode,
        linked_directories: Vec::new(),
    };

    let mut output = String::new();
    let result = service::send_message(params, &mut |event| {
        if let AgentStreamEvent::StreamingPartial { message } = event {
            for part in &message.content {
                if let ExtendedMessagePart::Basic(MessagePart::Text { text, .. }) = part {
                    output.push_str(text);
                }
            }
        }
    })?;

    if output.is_empty() {
        output = format!(
            "Task completed. Session: {}, Model: {}/{}",
            result.session_id, result.provider, result.model
        );
    }
    if is_compact_response(args) {
        output = truncate_text(&output, 2_000);
    }

    Ok(output)
}
