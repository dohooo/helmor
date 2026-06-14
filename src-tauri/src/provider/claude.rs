//! Claude custom-provider backend (Anthropic-compatible endpoints).
//! Accepts the multi-slot array and the legacy single-slot object (migrated on read).
//! Preset id == preset key, so `claude-custom|<key>|<model>` ids stay stable.

use serde::Deserialize;

use super::types::{CustomProvider, CustomProviderModel};
use super::CustomProviderBackend;

const SETTINGS_KEY: &str = "app.claude_custom_providers";
const MODEL_ID_PREFIX: &str = "claude-custom|";

#[derive(Debug, Clone)]
pub struct ClaudeProviderModel {
    pub id: String,
    pub provider_key: String,
    pub label: String,
    pub cli_model: String,
    pub base_url: String,
    pub api_key: String,
}

/// Legacy single-slot shape.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ClaudeV1Settings {
    #[serde(default)]
    builtin_provider_api_keys: std::collections::HashMap<String, String>,
    #[serde(default)]
    custom_base_url: String,
    #[serde(default)]
    custom_api_key: String,
    #[serde(default)]
    custom_models: String,
}

fn model_id(provider_key: &str, model: &str) -> String {
    format!("{MODEL_ID_PREFIX}{provider_key}|{model}")
}

/// Multi-slot array; legacy object migrated on read.
pub fn list() -> Vec<CustomProvider> {
    crate::settings::load_setting_value(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map(parse_stored)
        .unwrap_or_default()
}

fn parse_stored(value: serde_json::Value) -> Vec<CustomProvider> {
    if value.is_array() {
        serde_json::from_value(value).unwrap_or_default()
    } else if value.is_object() {
        migrate_v1(serde_json::from_value(value).unwrap_or_default())
    } else {
        Vec::new()
    }
}

fn migrate_v1(v1: ClaudeV1Settings) -> Vec<CustomProvider> {
    let mut out = Vec::new();
    for preset in super::builtin_claude::builtin_claude_providers() {
        let Some(api_key) = v1
            .builtin_provider_api_keys
            .get(&preset.key)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        out.push(CustomProvider {
            id: preset.key.clone(),
            name: preset.label.clone(),
            preset_key: Some(preset.key.clone()),
            base_url: preset.base_url.clone(),
            api_key: api_key.to_string(),
            models: Vec::new(),
            ..Default::default()
        });
    }
    let base = v1.custom_base_url.trim();
    let api = v1.custom_api_key.trim();
    if !base.is_empty() && !api.is_empty() {
        out.push(CustomProvider {
            id: "custom".to_string(),
            name: "Custom".to_string(),
            base_url: base.to_string(),
            api_key: api.to_string(),
            models: parse_model_lines(&v1.custom_models)
                .into_iter()
                .map(|slug| CustomProviderModel {
                    label: slug.clone(),
                    slug,
                    effort_levels: Vec::new(),
                })
                .collect(),
            ..Default::default()
        });
    }
    out
}

pub fn configured_models() -> Vec<ClaudeProviderModel> {
    expand_models(&list())
}

fn expand_models(providers: &[CustomProvider]) -> Vec<ClaudeProviderModel> {
    let mut models = Vec::new();
    for provider in providers {
        let base_url = provider.base_url.trim();
        let api_key = provider.api_key.trim();
        if base_url.is_empty() || api_key.is_empty() {
            continue;
        }
        let mut seen = std::collections::HashSet::new();
        for model in &provider.models {
            let slug = model.slug.trim();
            if slug.is_empty() || !seen.insert(slug.to_string()) {
                continue;
            }
            let label = model.label.trim();
            models.push(ClaudeProviderModel {
                id: model_id(&provider.id, slug),
                provider_key: provider.id.clone(),
                label: if label.is_empty() {
                    slug.to_string()
                } else {
                    label.to_string()
                },
                cli_model: slug.to_string(),
                base_url: base_url.to_string(),
                api_key: api_key.to_string(),
            });
        }
    }
    models
}

pub fn resolve(model_id: &str) -> Option<ClaudeProviderModel> {
    configured_models()
        .into_iter()
        .find(|model| model.id == model_id)
}

fn parse_model_lines(raw: &str) -> Vec<String> {
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

/// Fetch models from the Anthropic-compatible `/v1/models`. Many proxies
/// don't implement it; callers fall back to manual entry on failure.
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
) -> anyhow::Result<Vec<CustomProviderModel>> {
    use anyhow::Context;
    let url = format!("{}/v1/models", base_url.trim().trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("build http client")?;
    let response = client
        .get(&url)
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .context("request /v1/models")?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("models endpoint returned HTTP {status}");
    }
    let body: serde_json::Value = response.json().await.context("parse /v1/models json")?;
    super::codex::parse_models_response(&body, |_| false)
}

pub struct ClaudeBackend;

impl CustomProviderBackend for ClaudeBackend {
    fn list(&self) -> Vec<CustomProvider> {
        list()
    }

    fn upsert(&self, provider: CustomProvider) -> anyhow::Result<()> {
        let mut providers = list();
        match providers.iter_mut().find(|p| p.id == provider.id) {
            Some(existing) => *existing = provider,
            None => providers.push(provider),
        }
        crate::settings::upsert_setting_json(SETTINGS_KEY, &providers)?;
        Ok(())
    }

    fn remove(&self, id: &str) -> anyhow::Result<()> {
        let mut providers = list();
        providers.retain(|p| p.id != id);
        crate::settings::upsert_setting_json(SETTINGS_KEY, &providers)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_model_lines() {
        assert_eq!(
            parse_model_lines("a\nb\nc\na | bad"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn parses_v2_array_with_stable_model_id() {
        let list = parse_stored(json!([{
            "id": "acme",
            "name": "Acme",
            "baseUrl": "https://acme/v1",
            "apiKey": "sk",
            "models": [{"slug": "m", "label": "M"}],
            "enabledModelIds": null
        }]));
        let models = expand_models(&list);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-custom|acme|m");
        assert_eq!(models[0].provider_key, "acme");
        assert_eq!(models[0].label, "M");
        assert_eq!(models[0].base_url, "https://acme/v1");
    }

    #[test]
    fn migrates_v1_custom_block() {
        let list = parse_stored(json!({
            "customBaseUrl": "https://x/v1",
            "customApiKey": "sk",
            "customModels": "m1\nm2"
        }));
        let custom = list.iter().find(|p| p.id == "custom").expect("custom slot");
        assert_eq!(custom.base_url, "https://x/v1");
        assert_eq!(custom.models.len(), 2);
        let models = expand_models(&list);
        assert_eq!(models[0].id, "claude-custom|custom|m1");
    }

    #[test]
    fn expand_skips_incomplete_providers() {
        let providers = vec![CustomProvider {
            id: "a".to_string(),
            base_url: "https://a/v1".to_string(),
            api_key: String::new(),
            models: vec![CustomProviderModel {
                slug: "m".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        }];
        assert!(expand_models(&providers).is_empty());
    }
}
