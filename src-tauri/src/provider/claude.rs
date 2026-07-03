//! Claude custom-provider backend (Anthropic-compatible endpoints).
//! Accepts the multi-slot array and the legacy single-slot object (migrated on read).
//! Preset id == preset key, so `claude-custom|<key>|<model>` ids stay stable.

use serde::Deserialize;

use super::types::{CustomProvider, CustomProviderModel};
use super::CustomProviderBackend;

const SETTINGS_KEY: &str = "app.claude_custom_providers";
const MODEL_ID_PREFIX: &str = "claude-custom|";

pub const VERTEX_API_STYLE: &str = "vertex";
pub const VERTEX_AUTH_KEYCHAIN: &str = "keychain";
/// Fixed Keychain item names — not user-configurable. Namespaced under
/// `helmor-` so `security … -U` can never clobber a user's own
/// `anthropic-auth-token` item; the account is the provider id so multiple
/// Vertex providers keep separate tokens.
pub const VERTEX_KEYCHAIN_SERVICE: &str = "helmor-anthropic-auth-token";

/// How Claude Code authenticates to the Vertex gateway once
/// `CLAUDE_CODE_SKIP_VERTEX_AUTH` disables GCP request signing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeVertexAuth {
    /// Plaintext gateway token → `ANTHROPIC_AUTH_TOKEN`.
    Token(String),
    /// macOS Keychain item, read by the CLI itself via `apiKeyHelper`
    /// (`security find-generic-password`) — the token never enters Helmor.
    Keychain { service: String, account: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeVertexConfig {
    /// Gateway endpoint → `ANTHROPIC_VERTEX_BASE_URL`.
    pub base_url: String,
    /// `ANTHROPIC_VERTEX_PROJECT_ID`; empty → CLI-side fallbacks apply.
    pub project_id: String,
    /// `CLOUD_ML_REGION`; empty → "global".
    pub region: String,
    pub auth: ClaudeVertexAuth,
}

#[derive(Debug, Clone)]
pub struct ClaudeProviderModel {
    pub id: String,
    pub provider_key: String,
    pub label: String,
    pub cli_model: String,
    pub base_url: String,
    pub api_key: String,
    /// Some → Vertex-type provider (`apiStyle == "vertex"`).
    pub vertex: Option<ClaudeVertexConfig>,
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

/// Some ⟺ the provider is Vertex-type and complete enough to use.
fn vertex_config(provider: &CustomProvider) -> Option<ClaudeVertexConfig> {
    if provider.api_style.as_deref() != Some(VERTEX_API_STYLE) {
        return None;
    }
    let trimmed = |v: &Option<String>| v.as_deref().unwrap_or_default().trim().to_string();
    // Keychain auth is macOS-only (`security` + apiKeyHelper). Elsewhere a
    // keychain-flagged provider degrades to token mode: usable once a token
    // is set, skipped otherwise.
    let keychain = cfg!(target_os = "macos")
        && provider.vertex_auth_mode.as_deref() == Some(VERTEX_AUTH_KEYCHAIN);
    let auth = if keychain {
        ClaudeVertexAuth::Keychain {
            service: VERTEX_KEYCHAIN_SERVICE.to_string(),
            account: provider.id().to_string(),
        }
    } else {
        let token = provider.api_key.trim();
        if token.is_empty() {
            return None;
        }
        ClaudeVertexAuth::Token(token.to_string())
    };
    Some(ClaudeVertexConfig {
        base_url: provider.base_url.trim().to_string(),
        project_id: trimmed(&provider.vertex_project_id),
        region: trimmed(&provider.vertex_region),
        auth,
    })
}

fn expand_models(providers: &[CustomProvider]) -> Vec<ClaudeProviderModel> {
    let mut models = Vec::new();
    for provider in providers {
        let base_url = provider.base_url.trim();
        let api_key = provider.api_key.trim();
        if base_url.is_empty() {
            continue;
        }
        let vertex = vertex_config(provider);
        // Keychain-auth Vertex providers legitimately have no stored key.
        if api_key.is_empty() && vertex.is_none() {
            continue;
        }
        // Custom models are merged into the official Claude section (composer
        // and Settings alike), so each label is prefixed with its provider
        // name (`Name · model`) — otherwise a custom `claude-opus-4-8` is
        // indistinguishable from the official one. Mirrors Codex/OpenCode.
        let prefix = match provider.name.trim() {
            "" => provider.id.trim(),
            name => name,
        };
        let mut seen = std::collections::HashSet::new();
        for model in &provider.models {
            let slug = model.slug.trim();
            if slug.is_empty() || !seen.insert(slug.to_string()) {
                continue;
            }
            let label = match model.label.trim() {
                "" => slug,
                label => label,
            };
            models.push(ClaudeProviderModel {
                id: model_id(&provider.id, slug),
                provider_key: provider.id.clone(),
                label: format!("{prefix} · {label}"),
                cli_model: slug.to_string(),
                base_url: base_url.to_string(),
                api_key: api_key.to_string(),
                vertex: vertex.clone(),
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
        // Best-effort Keychain cleanup before the row is gone: the token
        // item is keyed by provider id, so a deleted Vertex provider would
        // otherwise strand it forever. Missing item / errors are fine.
        #[cfg(target_os = "macos")]
        if providers
            .iter()
            .any(|p| p.id == id && p.api_style.as_deref() == Some(VERTEX_API_STYLE))
        {
            delete_vertex_keychain_item(id);
        }
        providers.retain(|p| p.id != id);
        crate::settings::upsert_setting_json(SETTINGS_KEY, &providers)?;
        Ok(())
    }
}

/// Delete the provider's Keychain token item. Best-effort: the item may
/// never have been created (token mode, or the user closed the store
/// dialog), and `security` exits non-zero for "not found" — both ignored.
#[cfg(target_os = "macos")]
fn delete_vertex_keychain_item(account: &str) {
    let result = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            VERTEX_KEYCHAIN_SERVICE,
            "-a",
            account,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if let Err(error) = result {
        tracing::debug!(%error, "vertex keychain cleanup: could not run `security`");
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
        assert_eq!(models[0].label, "Acme · M");
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

    fn vertex_provider(auth_mode: Option<&str>, api_key: &str) -> CustomProvider {
        CustomProvider {
            id: "gw".to_string(),
            base_url: "https://gateway.example.ai/api".to_string(),
            api_key: api_key.to_string(),
            api_style: Some("vertex".to_string()),
            vertex_project_id: Some("acme".to_string()),
            vertex_auth_mode: auth_mode.map(str::to_string),
            models: vec![CustomProviderModel {
                slug: "claude-opus-4-8".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn vertex_token_mode_requires_api_key() {
        // Token mode with no key is unusable — skipped like plain providers.
        assert!(expand_models(&[vertex_provider(None, "")]).is_empty());

        let models = expand_models(&[vertex_provider(None, "sk-gw")]);
        assert_eq!(models.len(), 1);
        let vertex = models[0].vertex.as_ref().expect("vertex config");
        assert_eq!(vertex.auth, ClaudeVertexAuth::Token("sk-gw".to_string()));
        assert_eq!(vertex.project_id, "acme");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vertex_keychain_mode_needs_no_api_key_and_uses_fixed_item_names() {
        let models = expand_models(&[vertex_provider(Some("keychain"), "")]);
        assert_eq!(models.len(), 1);
        let vertex = models[0].vertex.as_ref().expect("vertex config");
        assert_eq!(
            vertex.auth,
            ClaudeVertexAuth::Keychain {
                service: VERTEX_KEYCHAIN_SERVICE.to_string(),
                // Account is the provider id — per-provider token isolation.
                account: "gw".to_string(),
            }
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn vertex_keychain_mode_degrades_to_token_off_macos() {
        // No token → unusable; with a token → plain token auth.
        assert!(expand_models(&[vertex_provider(Some("keychain"), "")]).is_empty());
        let models = expand_models(&[vertex_provider(Some("keychain"), "sk-gw")]);
        assert_eq!(models.len(), 1);
        assert_eq!(
            models[0].vertex.as_ref().expect("vertex config").auth,
            ClaudeVertexAuth::Token("sk-gw".to_string())
        );
    }

    #[test]
    fn non_vertex_provider_has_no_vertex_config() {
        let mut provider = vertex_provider(None, "sk");
        provider.api_style = None;
        let models = expand_models(&[provider]);
        assert_eq!(models.len(), 1);
        assert!(models[0].vertex.is_none());
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
