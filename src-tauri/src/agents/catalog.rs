use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelOption {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub cli_model: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effort_levels: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub supports_fast_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSection {
    pub id: String,
    pub label: String,
    pub options: Vec<AgentModelOption>,
}

/// Resolved model info needed by the streaming path.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub id: String,
    pub provider: String,
    pub cli_model: String,
}

/// Resolve a model ID to provider + cli_model. Provider is inferred from the
/// ID: `gpt-*` → codex, everything else → claude. The ID is passed through
/// as cli_model directly — the sidecar/SDK handles the actual mapping.
pub fn resolve_model(model_id: &str) -> ResolvedModel {
    let provider = if model_id.starts_with("gpt-") {
        "codex"
    } else {
        "claude"
    };
    ResolvedModel {
        id: model_id.to_string(),
        provider: provider.to_string(),
        cli_model: model_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_claude_model() {
        let m = resolve_model("default");
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "default");
        assert_eq!(m.id, "default");
    }

    #[test]
    fn resolve_opus_model() {
        let m = resolve_model("opus");
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "opus");
    }

    #[test]
    fn resolve_sonnet_model() {
        let m = resolve_model("sonnet");
        assert_eq!(m.provider, "claude");
    }

    #[test]
    fn resolve_gpt_model_routes_to_codex() {
        let m = resolve_model("gpt-4o");
        assert_eq!(m.provider, "codex");
        assert_eq!(m.cli_model, "gpt-4o");
    }

    #[test]
    fn resolve_gpt_5_4_routes_to_codex() {
        let m = resolve_model("gpt-5.4");
        assert_eq!(m.provider, "codex");
    }

    #[test]
    fn resolve_unknown_model_defaults_to_claude() {
        let m = resolve_model("some-future-model");
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "some-future-model");
    }
}
