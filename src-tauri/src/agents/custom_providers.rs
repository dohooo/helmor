use std::collections::HashMap;

use serde::{Deserialize, Serialize};

const SETTINGS_KEY: &str = "app.claude_custom_providers";
const MODEL_ID_PREFIX: &str = "claude-custom|";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCustomProviderSettings {
    #[serde(default)]
    pub builtin_provider_api_keys: HashMap<String, String>,
    #[serde(default)]
    pub custom_base_url: String,
    #[serde(default)]
    pub custom_api_key: String,
    #[serde(default)]
    pub custom_models: String,
}

#[derive(Debug, Clone)]
pub struct ClaudeProviderModel {
    pub id: String,
    pub provider_key: String,
    pub label: String,
    pub cli_model: String,
    pub base_url: String,
    pub api_key: String,
}

pub fn load_settings() -> ClaudeCustomProviderSettings {
    crate::settings::load_setting_json::<ClaudeCustomProviderSettings>(SETTINGS_KEY)
        .ok()
        .flatten()
        .unwrap_or_default()
}

pub fn configured_models() -> Vec<ClaudeProviderModel> {
    let settings = load_settings();
    let mut models = Vec::new();

    for provider in super::builtin_claude_providers::builtin_claude_providers() {
        append_builtin_models(
            &mut models,
            provider.key.as_str(),
            builtin_api_key(&settings, provider.key.as_str()).trim(),
        );
    }

    let base_url = settings.custom_base_url.trim();
    let api_key = settings.custom_api_key.trim();
    if !base_url.is_empty() && !api_key.is_empty() {
        for model in parse_models(&settings.custom_models) {
            models.push(ClaudeProviderModel {
                id: model_id("custom", &model),
                provider_key: "custom".to_string(),
                label: model.clone(),
                cli_model: model,
                base_url: base_url.to_string(),
                api_key: api_key.to_string(),
            });
        }
    }

    models
}

fn builtin_api_key(settings: &ClaudeCustomProviderSettings, provider_key: &str) -> String {
    settings
        .builtin_provider_api_keys
        .get(provider_key)
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn append_builtin_models(models: &mut Vec<ClaudeProviderModel>, provider_key: &str, api_key: &str) {
    if api_key.is_empty() {
        return;
    }

    let Some(provider) = super::builtin_claude_providers::builtin_claude_providers()
        .iter()
        .find(|provider| provider.key == provider_key)
    else {
        return;
    };

    for model in &provider.models {
        models.push(ClaudeProviderModel {
            id: model_id(provider.key.as_str(), model.id.as_str()),
            provider_key: provider.key.clone(),
            label: model.label.clone(),
            cli_model: model.id.clone(),
            base_url: provider.base_url.clone(),
            api_key: api_key.to_string(),
        });
    }
}

pub fn resolve(model_id: &str) -> Option<ClaudeProviderModel> {
    configured_models()
        .into_iter()
        .find(|model| model.id == model_id)
}

fn model_id(provider_key: &str, model: &str) -> String {
    format!("{MODEL_ID_PREFIX}{provider_key}|{model}")
}

fn parse_models(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for item in raw.lines() {
        let model = item.trim();
        if model.is_empty() || model.contains('|') || out.iter().any(|m| m == model) {
            continue;
        }
        out.push(model.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_model_list() {
        assert_eq!(
            parse_models("a\nb\nc\na | bad"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn builtin_api_key_reads_canonical_map() {
        let settings: ClaudeCustomProviderSettings =
            serde_json::from_str(r#"{"builtinProviderApiKeys":{"minimax":"mapped"}}"#).unwrap();

        assert_eq!(builtin_api_key(&settings, "minimax"), "mapped");
    }

    #[test]
    fn builtin_api_key_ignores_blank_values() {
        let settings: ClaudeCustomProviderSettings =
            serde_json::from_str(r#"{"builtinProviderApiKeys":{"minimax":"   "}}"#).unwrap();

        assert_eq!(builtin_api_key(&settings, "minimax"), "");
    }
}
