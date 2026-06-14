//! Codex custom-provider backend. Routes through the Codex app-server with a
//! provider definition injected per-thread (`modelProvider` + bearer token);
//! never touches `~/.codex/config.toml`. Each provider is its own catalog id
//! (`codex:<id>`) since Codex binds the provider at thread start (no mid-thread switch).

use super::types::{is_enabled, CustomProvider, CustomProviderModel};
use super::CustomProviderBackend;

const SETTINGS_KEY: &str = "app.codex_custom_providers";
/// Catalog/persistence prefix. The sidecar provider stays `codex`.
pub const PROVIDER_PREFIX: &str = "codex:";
const MODEL_ID_SEP: char = '|';

#[derive(Debug, Clone)]
pub struct CodexProviderModel {
    /// `codex:<providerId>|<wireModel>` — stable picker/persistence id.
    pub id: String,
    /// Catalog/persistence provider id: `codex:<providerId>`.
    pub provider: String,
    /// Bare provider id, used as Codex `modelProvider`.
    pub instance_id: String,
    /// Wire model name, sent verbatim to the endpoint.
    pub cli_model: String,
    pub base_url: String,
    pub api_key: String,
}

pub fn provider_id(instance_id: &str) -> String {
    format!("{PROVIDER_PREFIX}{instance_id}")
}

pub fn model_id(instance_id: &str, wire_model: &str) -> String {
    format!("{PROVIDER_PREFIX}{instance_id}{MODEL_ID_SEP}{wire_model}")
}

/// Raw configured providers, unfiltered.
pub fn list() -> Vec<CustomProvider> {
    crate::settings::load_setting_json::<Vec<CustomProvider>>(SETTINGS_KEY)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Usable providers (non-empty id + base_url). API key may be empty.
pub fn load_providers() -> Vec<CustomProvider> {
    list()
        .into_iter()
        .filter(CustomProvider::is_usable)
        .collect()
}

/// Every enabled model across every configured provider.
pub fn configured_models() -> Vec<CodexProviderModel> {
    models_for_providers(load_providers())
}

pub fn models_for_providers(providers: Vec<CustomProvider>) -> Vec<CodexProviderModel> {
    let mut out = Vec::new();
    for provider in providers {
        let base_url = provider.base_url.trim();
        let instance_id = provider.id.trim();
        if instance_id.is_empty() || base_url.is_empty() {
            continue;
        }
        let api_key = provider.api_key.trim();
        let provider_id = provider_id(instance_id);
        let enabled = provider.enabled_model_ids.as_deref();
        let mut seen = std::collections::HashSet::new();
        for model in &provider.models {
            let wire = model.slug.trim();
            if wire.is_empty() || !seen.insert(wire.to_string()) {
                continue;
            }
            if !is_enabled(enabled, wire) {
                continue;
            }
            out.push(CodexProviderModel {
                id: model_id(instance_id, wire),
                provider: provider_id.clone(),
                instance_id: instance_id.to_string(),
                cli_model: wire.to_string(),
                base_url: base_url.to_string(),
                api_key: api_key.to_string(),
            });
        }
    }
    out
}

pub fn resolve(model_id: &str) -> Option<CodexProviderModel> {
    // Ignore the enabled filter so a session pinned to a now-hidden model still resolves.
    let providers = load_providers()
        .into_iter()
        .map(|mut provider| {
            provider.enabled_model_ids = None;
            provider
        })
        .collect();
    models_for_providers(providers)
        .into_iter()
        .find(|model| model.id == model_id)
}

/// First enabled model of a provider instance (used by title generation).
pub fn first_model_for(instance_id: &str) -> Option<CodexProviderModel> {
    configured_models()
        .into_iter()
        .find(|model| model.instance_id == instance_id)
}

/// Non-coding slugs (image/audio/embedding/…) we never surface as models.
fn is_non_chat_model(slug: &str) -> bool {
    let s = slug.to_ascii_lowercase();
    [
        "image",
        "embedding",
        "tts",
        "whisper",
        "dall-e",
        "dalle",
        "moderation",
        "audio",
        "rerank",
        "transcribe",
    ]
    .iter()
    .any(|needle| s.contains(needle))
}

/// Fetch models from the OpenAI-compatible `/v1/models`. Accepts the OpenAI
/// shape, the Codex catalog shape, or a bare array. Non-chat models filtered out.
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
) -> anyhow::Result<Vec<CustomProviderModel>> {
    use anyhow::Context;
    let url = format!("{}/models", base_url.trim().trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("build http client")?;
    let mut request = client.get(&url);
    let key = api_key.trim();
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.context("request /v1/models")?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("models endpoint returned HTTP {status}");
    }
    let body: serde_json::Value = response.json().await.context("parse /v1/models json")?;
    parse_models_response(&body, is_non_chat_model)
}

/// Parse a `/v1/models` body, filtering slugs with `skip`.
pub(super) fn parse_models_response(
    body: &serde_json::Value,
    skip: impl Fn(&str) -> bool,
) -> anyhow::Result<Vec<CustomProviderModel>> {
    let items = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(serde_json::Value::as_array)
        .or_else(|| body.as_array())
        .ok_or_else(|| anyhow::anyhow!("unexpected /v1/models shape"))?;

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let Some(slug) = item
            .get("id")
            .or_else(|| item.get("slug"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if skip(slug) || !seen.insert(slug.to_string()) {
            continue;
        }
        let label = item
            .get("display_name")
            .or_else(|| item.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(slug)
            .to_string();
        out.push(CustomProviderModel {
            slug: slug.to_string(),
            label,
            effort_levels: Vec::new(),
        });
    }
    Ok(out)
}

pub struct CodexBackend;

impl CustomProviderBackend for CodexBackend {
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

    fn model(slug: &str) -> CustomProviderModel {
        CustomProviderModel {
            slug: slug.to_string(),
            label: slug.to_uppercase(),
            effort_levels: Vec::new(),
        }
    }

    fn provider(id: &str, models: &[&str]) -> CustomProvider {
        CustomProvider {
            id: id.to_string(),
            name: format!("Provider {id}"),
            base_url: "http://example.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            models: models.iter().map(|m| model(m)).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn expands_enabled_models_with_stable_ids() {
        let models = models_for_providers(vec![provider("hundun", &["gpt-5.5", "gpt-5.4"])]);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "codex:hundun|gpt-5.5");
        assert_eq!(models[0].provider, "codex:hundun");
        assert_eq!(models[0].instance_id, "hundun");
        assert_eq!(models[0].cli_model, "gpt-5.5");
    }

    #[test]
    fn enabled_subset_filters_models() {
        let mut p = provider("hundun", &["gpt-5.5", "gpt-5.4"]);
        p.enabled_model_ids = Some(vec!["gpt-5.4".to_string()]);
        let models = models_for_providers(vec![p]);
        assert_eq!(
            models
                .iter()
                .map(|m| m.cli_model.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.4"]
        );
    }

    #[test]
    fn empty_enabled_list_hides_all() {
        let mut p = provider("hundun", &["gpt-5.5"]);
        p.enabled_model_ids = Some(Vec::new());
        assert!(models_for_providers(vec![p]).is_empty());
    }

    #[test]
    fn skips_blank_and_duplicate_models() {
        let models = models_for_providers(vec![provider(
            "h",
            &["gpt-5.5", "  ", "gpt-5.5", "gpt-5.4"],
        )]);
        assert_eq!(
            models
                .iter()
                .map(|m| m.cli_model.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.5", "gpt-5.4"]
        );
    }

    #[test]
    fn skips_providers_without_base_url() {
        let mut p = provider("h", &["gpt-5.5"]);
        p.base_url = "   ".to_string();
        assert!(models_for_providers(vec![p]).is_empty());
    }

    #[test]
    fn handles_prefixed_wire_slugs() {
        let models = models_for_providers(vec![provider("ppio", &["ppio/pa/gpt-5.5"])]);
        assert_eq!(models[0].id, "codex:ppio|ppio/pa/gpt-5.5");
        assert_eq!(models[0].cli_model, "ppio/pa/gpt-5.5");
    }
}
