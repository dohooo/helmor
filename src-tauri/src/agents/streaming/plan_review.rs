//! Builders for the synthetic `exit_plan_message` row.
//!
//! Codex / Claude both surface plan-mode exits as a `planCaptured`
//! sidecar event; we translate that into a `ThreadMessageLike` whose
//! sole content part is a `PlanReview` so the frontend renders the
//! "Implement / Request Changes" card. The same shape is written to
//! `exit_plan_messages` on the DB side, which means
//! `convert_historical` produces an identical row on reload — and the
//! cache stays cache-consistent across the live → DB → reload round
//! trip.

use serde_json::Value;

use crate::pipeline::types::{
    ExtendedMessagePart, MessagePart, MessageRole, PlanAllowedPrompt, ThreadMessageLike,
};

/// Construct a plan-review `ThreadMessageLike` from a raw
/// `planCaptured` sidecar event's `toolInput`. `id` / `created_at`
/// stay `None` for the in-memory build; the call site fills them in
/// from the persisted DB row before emitting Update.
pub(super) fn build_exit_plan_review_message(
    id: Option<String>,
    created_at: Option<String>,
    tool_use_id: &str,
    tool_name: &str,
    tool_input: &Value,
) -> ThreadMessageLike {
    let plan = tool_input
        .get("plan")
        .and_then(Value::as_str)
        .map(str::to_string);
    let plan_file_path = tool_input
        .get("planFilePath")
        .and_then(Value::as_str)
        .map(str::to_string);
    let allowed_prompts = tool_input
        .get("allowedPrompts")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let tool = entry.get("tool").and_then(Value::as_str)?;
                    let prompt = entry.get("prompt").and_then(Value::as_str)?;
                    Some(PlanAllowedPrompt {
                        tool: tool.to_string(),
                        prompt: prompt.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    ThreadMessageLike {
        role: MessageRole::Assistant,
        id,
        created_at,
        content: vec![ExtendedMessagePart::Basic(MessagePart::PlanReview {
            tool_use_id: tool_use_id.to_string(),
            tool_name: tool_name.to_string(),
            plan,
            plan_file_path,
            allowed_prompts,
        })],
        status: None,
        streaming: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_extracts_plan_file_and_text_when_present() {
        let raw = json!({
            "plan": "1. Investigate\n2. Fix\n3. Verify",
            "planFilePath": "PLAN.md",
            "allowedPrompts": [],
        });

        let msg = build_exit_plan_review_message(
            Some("plan-1".into()),
            Some("2026-05-18T00:00:00Z".into()),
            "tool-use-1",
            "ExitPlanMode",
            &raw,
        );

        assert_eq!(msg.id.as_deref(), Some("plan-1"));
        assert_eq!(msg.created_at.as_deref(), Some("2026-05-18T00:00:00Z"));
        assert_eq!(msg.role, MessageRole::Assistant);
        assert_eq!(msg.content.len(), 1);
        match &msg.content[0] {
            ExtendedMessagePart::Basic(MessagePart::PlanReview {
                tool_use_id,
                tool_name,
                plan,
                plan_file_path,
                allowed_prompts,
            }) => {
                assert_eq!(tool_use_id, "tool-use-1");
                assert_eq!(tool_name, "ExitPlanMode");
                assert_eq!(plan.as_deref(), Some("1. Investigate\n2. Fix\n3. Verify"));
                assert_eq!(plan_file_path.as_deref(), Some("PLAN.md"));
                assert!(allowed_prompts.is_empty());
            }
            other => panic!("expected PlanReview, got {other:?}"),
        }
    }

    #[test]
    fn build_parses_allowed_prompts_dropping_malformed_entries() {
        // The SDK ships allowedPrompts as `[{tool, prompt}]`. Entries
        // missing either field should be silently dropped so a partial
        // payload doesn't crash the live render — the alternative is
        // an unwrap() that panics on every malformed event.
        let raw = json!({
            "plan": "",
            "allowedPrompts": [
                { "tool": "Bash", "prompt": "make test" },
                { "tool": "Bash" }, // missing prompt
                { "prompt": "no tool" },
                "not-an-object",
                { "tool": "Edit", "prompt": "format files" },
            ]
        });

        let msg = build_exit_plan_review_message(None, None, "t", "ExitPlanMode", &raw);

        match &msg.content[0] {
            ExtendedMessagePart::Basic(MessagePart::PlanReview {
                allowed_prompts, ..
            }) => {
                assert_eq!(allowed_prompts.len(), 2);
                assert_eq!(allowed_prompts[0].tool, "Bash");
                assert_eq!(allowed_prompts[0].prompt, "make test");
                assert_eq!(allowed_prompts[1].tool, "Edit");
                assert_eq!(allowed_prompts[1].prompt, "format files");
            }
            other => panic!("expected PlanReview, got {other:?}"),
        }
    }

    #[test]
    fn build_yields_none_fields_when_payload_omits_optional_keys() {
        // toolInput from older sidecar builds may carry just the
        // `plan` key, no allowedPrompts / planFilePath. The builder
        // must default to None / empty rather than blowing up.
        let raw = json!({ "plan": "Just a plan" });

        let msg = build_exit_plan_review_message(None, None, "t", "ExitPlanMode", &raw);

        match &msg.content[0] {
            ExtendedMessagePart::Basic(MessagePart::PlanReview {
                plan,
                plan_file_path,
                allowed_prompts,
                ..
            }) => {
                assert_eq!(plan.as_deref(), Some("Just a plan"));
                assert!(plan_file_path.is_none());
                assert!(allowed_prompts.is_empty());
            }
            other => panic!("expected PlanReview, got {other:?}"),
        }
    }

    #[test]
    fn build_yields_none_plan_when_plan_field_absent() {
        // ExitPlanMode with no `plan` text — the frontend renders just
        // the action buttons, no plan card. Verify we map to None
        // rather than empty-string so the frontend can branch on it.
        let raw = json!({ "planFilePath": "PLAN.md" });

        let msg = build_exit_plan_review_message(None, None, "t", "ExitPlanMode", &raw);

        match &msg.content[0] {
            ExtendedMessagePart::Basic(MessagePart::PlanReview { plan, .. }) => {
                assert!(plan.is_none());
            }
            other => panic!("expected PlanReview, got {other:?}"),
        }
    }
}
