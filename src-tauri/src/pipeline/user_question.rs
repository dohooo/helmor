//! Provider-raw question payloads → the canonical `UserQuestion` shape.
//!
//! All three question-capable providers ride the same `userInputRequest`
//! wire event but with their native question arrays:
//!
//! - Claude AskUserQuestion: `{question, header, multiSelect, options:[{label, description, preview?}]}`
//! - Codex `requestUserInput`: `{id?, header?, question?, isOther?, options:[{label?, description?}]}`
//! - OpenCode `question`: `{question, header, options:[{label, description}], multiple?}`
//!
//! This module is the single adaptation point (used by the streaming
//! bridge for the live panel AND by the accumulator/adapter for the
//! persisted transcript card) so the frontend only ever sees one shape.
//! Answers are keyed by question text everywhere — that is Claude's
//! native `updatedInput.answers` contract and the sidecar managers map
//! it back to each provider's reply shape.

use serde_json::Value;

use super::types::{MessagePart, UserQuestionItem, UserQuestionOption, UserQuestionStatus};

/// Normalize a provider-raw `questions` array. Unknown providers fall
/// back to the Claude/AUQ field names, which OpenCode's shape is a
/// superset-compatible variant of (`multiple` vs `multiSelect`).
pub fn normalize_questions(provider: &str, raw: &Value) -> Vec<UserQuestionItem> {
    let Some(items) = raw.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(idx, q)| normalize_question(provider, q, idx))
        .collect()
}

fn normalize_question(provider: &str, raw: &Value, idx: usize) -> Option<UserQuestionItem> {
    let obj = raw.as_object()?;
    let str_field = |key: &str| obj.get(key).and_then(Value::as_str).map(str::to_string);

    let header = str_field("header").filter(|s| !s.is_empty());
    let question = str_field("question")
        .filter(|s| !s.is_empty())
        .or_else(|| header.clone())
        .unwrap_or_else(|| format!("Question {}", idx + 1));

    let mut options: Vec<UserQuestionOption> = obj
        .get("options")
        .and_then(Value::as_array)
        .map(|opts| {
            opts.iter()
                .filter_map(|o| {
                    let o = o.as_object()?;
                    let label = o.get("label").and_then(Value::as_str)?;
                    if label.is_empty() {
                        return None;
                    }
                    Some(UserQuestionOption {
                        label: label.to_string(),
                        description: o
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string),
                        preview: o.get("preview").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let (multi_select, allow_free_text) = match provider {
        "codex" => {
            let is_other = obj.get("isOther").and_then(Value::as_bool).unwrap_or(false);
            // Codex question without options and without free text means a
            // confirmation — mirror the Yes/No choices its own client shows.
            if options.is_empty() && !is_other {
                options = vec![
                    UserQuestionOption {
                        label: "Yes".to_string(),
                        description: None,
                        preview: None,
                    },
                    UserQuestionOption {
                        label: "No".to_string(),
                        description: None,
                        preview: None,
                    },
                ];
            }
            (false, is_other)
        }
        "opencode" => (
            obj.get("multiple")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            true,
        ),
        _ => (
            obj.get("multiSelect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            true,
        ),
    };

    if options.is_empty() && !allow_free_text {
        return None;
    }

    Some(UserQuestionItem {
        question,
        header,
        multi_select,
        options,
        allow_free_text,
    })
}

/// Normalize the `payload` of a `userInputRequest` sidecar event for the
/// frontend. Only `kind: "ask-user-question"` payloads are rewritten
/// (provider-raw questions → canonical items); `form` / `url` pass through.
pub fn normalize_user_input_payload(provider: &str, payload: Value) -> Value {
    let Some(obj) = payload.as_object() else {
        return payload;
    };
    if obj.get("kind").and_then(Value::as_str) != Some("ask-user-question") {
        return payload;
    }
    let questions = normalize_questions(provider, obj.get("questions").unwrap_or(&Value::Null));
    let mut next = obj.clone();
    next.insert(
        "questions".to_string(),
        serde_json::to_value(questions).unwrap_or(Value::Array(Vec::new())),
    );
    Value::Object(next)
}

/// Build the `UserQuestion` part for a Claude `AskUserQuestion` tool_use
/// block. Answers arrive later via the tool_result merge
/// (`apply_result_to_user_question`); status starts from the streaming
/// state (`error` = the turn aborted while the question was open).
pub fn part_from_claude_tool_use(
    tool_call_id: &str,
    args: &Value,
    streaming_error: bool,
) -> Option<MessagePart> {
    let questions = normalize_questions("claude", args.get("questions").unwrap_or(&Value::Null));
    if questions.is_empty() {
        return None;
    }
    Some(MessagePart::UserQuestion {
        id: tool_call_id.to_string(),
        source: "Claude".to_string(),
        questions,
        answers: None,
        status: if streaming_error {
            UserQuestionStatus::Cancelled
        } else {
            UserQuestionStatus::Pending
        },
    })
}

/// Merge a tool_result into a `UserQuestion` part. `structured` is the
/// SDK user message's `tool_use_result` (carries `{questions, answers}`
/// for AskUserQuestion); `content` is the flat result string fallback.
pub fn apply_result_to_user_question(
    answers: &mut Option<Value>,
    status: &mut UserQuestionStatus,
    structured: Option<&Value>,
    content: &str,
    is_error: Option<bool>,
) {
    if is_error == Some(true) {
        *status = UserQuestionStatus::Declined;
        return;
    }
    *status = UserQuestionStatus::Answered;
    *answers = structured
        .and_then(|s| s.get("answers"))
        .filter(|a| a.is_object())
        .cloned()
        .or_else(|| parse_answers_from_result_text(content));
}

/// Best-effort fallback parser for the AskUserQuestion result string:
/// `Your questions have been answered: "<q>"="<a>", "<q>"="<a>". You can …`.
/// Quotes inside questions/answers are not escaped by the tool, so this
/// only recovers well-formed pairs; the structured `tool_use_result` is
/// always preferred.
fn parse_answers_from_result_text(content: &str) -> Option<Value> {
    let mut map = serde_json::Map::new();
    let mut rest = content;
    while let Some(q_start) = rest.find('"') {
        rest = &rest[q_start + 1..];
        let q_end = rest.find("\"=\"")?;
        let question = &rest[..q_end];
        rest = &rest[q_end + 3..];
        let a_end = rest.find('"')?;
        let answer = &rest[..a_end];
        rest = &rest[a_end + 1..];
        if !question.is_empty() {
            map.insert(question.to_string(), Value::String(answer.to_string()));
        }
    }
    (!map.is_empty()).then_some(Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_claude_questions_verbatim() {
        let raw = json!([{
            "question": "Pick a color",
            "header": "Color",
            "multiSelect": true,
            "options": [
                {"label": "Red", "description": "warm", "preview": "#f00"},
                {"label": "Blue"}
            ]
        }]);
        let items = normalize_questions("claude", &raw);
        assert_eq!(items.len(), 1);
        let q = &items[0];
        assert_eq!(q.question, "Pick a color");
        assert_eq!(q.header.as_deref(), Some("Color"));
        assert!(q.multi_select);
        assert!(q.allow_free_text);
        assert_eq!(q.options.len(), 2);
        assert_eq!(q.options[0].preview.as_deref(), Some("#f00"));
        assert_eq!(q.options[1].description, None);
    }

    #[test]
    fn normalizes_codex_questions_with_yes_no_fallback() {
        let raw = json!([
            {"id": "q0", "header": "Proceed", "question": "Apply the patch?"},
            {"id": "q1", "question": "Branch name?", "isOther": true},
            {"id": "q2", "header": "Mode", "question": "Pick one", "options": [
                {"label": "Fast", "description": "skip checks"}
            ]}
        ]);
        let items = normalize_questions("codex", &raw);
        assert_eq!(items.len(), 3);
        // No options + no isOther → synthesized Yes/No confirmation.
        assert_eq!(items[0].options.len(), 2);
        assert_eq!(items[0].options[0].label, "Yes");
        assert!(!items[0].allow_free_text);
        // isOther → pure free-text question.
        assert!(items[1].options.is_empty());
        assert!(items[1].allow_free_text);
        // Real options, no isOther → options only.
        assert_eq!(items[2].options.len(), 1);
        assert!(!items[2].allow_free_text);
        assert!(!items[2].multi_select);
    }

    #[test]
    fn normalizes_opencode_multiple_flag() {
        let raw = json!([{
            "question": "Which files?",
            "header": "Files",
            "multiple": true,
            "options": [{"label": "a.rs", "description": ""}]
        }]);
        let items = normalize_questions("opencode", &raw);
        assert_eq!(items.len(), 1);
        assert!(items[0].multi_select);
        assert!(items[0].allow_free_text);
        assert_eq!(items[0].options[0].description, None);
    }

    #[test]
    fn question_text_falls_back_to_header_then_index() {
        let items = normalize_questions("codex", &json!([{"header": "Only header"}, {}]));
        assert_eq!(items[0].question, "Only header");
        assert_eq!(items[1].question, "Question 2");
    }

    #[test]
    fn payload_normalization_only_touches_ask_user_question() {
        let form = json!({"kind": "form", "schema": {"type": "object"}});
        assert_eq!(normalize_user_input_payload("codex", form.clone()), form);

        let auq = json!({
            "kind": "ask-user-question",
            "questions": [{"id": "q0", "question": "Go?", "isOther": false}],
        });
        let normalized = normalize_user_input_payload("codex", auq);
        let qs = normalized
            .get("questions")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(qs[0].get("question").unwrap(), "Go?");
        assert_eq!(
            qs[0]
                .get("options")
                .and_then(Value::as_array)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn parses_answer_pairs_from_result_text() {
        let text = r#"Your questions have been answered: "Pick a color"="Red", "Why?"="Because". You can now continue with these answers in mind."#;
        let parsed = parse_answers_from_result_text(text).unwrap();
        assert_eq!(parsed.get("Pick a color").unwrap(), "Red");
        assert_eq!(parsed.get("Why?").unwrap(), "Because");
    }

    #[test]
    fn result_merge_prefers_structured_answers_and_maps_decline() {
        let mut answers = None;
        let mut status = UserQuestionStatus::Pending;
        apply_result_to_user_question(
            &mut answers,
            &mut status,
            Some(&json!({"questions": [], "answers": {"Q": "A"}})),
            "ignored",
            None,
        );
        assert_eq!(status, UserQuestionStatus::Answered);
        assert_eq!(answers.unwrap().get("Q").unwrap(), "A");

        let mut answers = None;
        let mut status = UserQuestionStatus::Pending;
        apply_result_to_user_question(&mut answers, &mut status, None, "User declined", Some(true));
        assert_eq!(status, UserQuestionStatus::Declined);
        assert!(answers.is_none());
    }
}
