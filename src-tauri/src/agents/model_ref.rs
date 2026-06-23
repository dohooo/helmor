//! Parse the global model-preference settings (default / review / PR). They
//! store a `{provider, modelId}` JSON object so the provider is explicit;
//! legacy rows hold a bare model id with no provider (resolved via the
//! `resolve_model` heuristic — safe because pre-fork data never collides
//! across the opencode-protocol providers).

use serde::Deserialize;

/// A stored model preference: an explicit provider (new JSON form) or `None`
/// for a legacy bare id, plus the model id itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredModel {
    pub provider: Option<String>,
    pub model_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelRefJson {
    #[serde(default)]
    provider: Option<String>,
    model_id: String,
}

/// Parse a stored model-preference value. Accepts the `{provider, modelId}`
/// JSON form and legacy bare ids. `None` for empty/blank input.
pub fn parse_stored_model(raw: &str) -> Option<StoredModel> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<ModelRefJson>(trimmed) {
        let model_id = parsed.model_id.trim().to_string();
        if !model_id.is_empty() {
            return Some(StoredModel {
                provider: parsed
                    .provider
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty()),
                model_id,
            });
        }
    }
    // Legacy bare id (or any non-JSON string): provider unknown → heuristic.
    Some(StoredModel {
        provider: None,
        model_id: trimmed.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_form_with_provider() {
        let parsed =
            parse_stored_model(r#"{"provider":"opencode","modelId":"opencode/grok-code"}"#)
                .unwrap();
        assert_eq!(parsed.provider.as_deref(), Some("opencode"));
        assert_eq!(parsed.model_id, "opencode/grok-code");
    }

    #[test]
    fn parses_legacy_bare_id_without_provider() {
        let parsed = parse_stored_model("claude-sonnet-4-5").unwrap();
        assert_eq!(parsed.provider, None);
        assert_eq!(parsed.model_id, "claude-sonnet-4-5");
        // A slug-shaped legacy id is still bare — no provider until re-saved.
        let parsed = parse_stored_model("openai/gpt-5-codex").unwrap();
        assert_eq!(parsed.provider, None);
        assert_eq!(parsed.model_id, "openai/gpt-5-codex");
    }

    #[test]
    fn json_without_provider_yields_none_provider() {
        let parsed = parse_stored_model(r#"{"modelId":"gpt-5.5"}"#).unwrap();
        assert_eq!(parsed.provider, None);
        assert_eq!(parsed.model_id, "gpt-5.5");
    }

    #[test]
    fn blank_and_empty_provider_are_normalized() {
        assert!(parse_stored_model("   ").is_none());
        assert!(parse_stored_model("").is_none());
        // Empty provider string → treated as unknown.
        let parsed = parse_stored_model(r#"{"provider":"","modelId":"sonnet"}"#).unwrap();
        assert_eq!(parsed.provider, None);
        assert_eq!(parsed.model_id, "sonnet");
    }
}
