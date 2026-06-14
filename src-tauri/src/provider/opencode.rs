//! OpenCode / MiMo Code custom-provider backend. File-backed; list/upsert/remove
//! delegate to `opencode_config`. Written models always carry `reasoning: true`.

use super::opencode_config::{self, OpencodeCustomModel, OpencodeCustomProvider};
use super::types::{CustomProvider, CustomProviderModel, ProviderFamily};
use super::CustomProviderBackend;

const NPM_CHAT: &str = "@ai-sdk/openai-compatible";
const NPM_RESPONSES: &str = "@ai-sdk/openai";

fn to_custom(p: OpencodeCustomProvider) -> CustomProvider {
    // No baseURL → registry preset (apiKey-only); id is the models.dev key.
    let is_preset = p.base_url.trim().is_empty();
    let api_style = if p.npm == NPM_RESPONSES {
        "responses"
    } else {
        "chat"
    };
    CustomProvider {
        preset_key: if is_preset { Some(p.id.clone()) } else { None },
        id: p.id,
        name: p.name,
        base_url: p.base_url,
        api_key: p.api_key,
        api_style: Some(api_style.to_string()),
        headers: if p.headers.is_empty() {
            None
        } else {
            Some(p.headers.into_iter().collect())
        },
        models: p
            .models
            .into_iter()
            .map(|m| CustomProviderModel {
                slug: m.id,
                label: m.name,
                effort_levels: Vec::new(),
            })
            .collect(),
        enabled_model_ids: None,
    }
}

fn to_opencode(p: CustomProvider) -> OpencodeCustomProvider {
    let npm = if p.api_style.as_deref() == Some("responses") {
        NPM_RESPONSES
    } else {
        NPM_CHAT
    };
    OpencodeCustomProvider {
        id: p.id,
        name: p.name,
        npm: npm.to_string(),
        base_url: p.base_url,
        api_key: p.api_key,
        headers: p.headers.unwrap_or_default().into_iter().collect(),
        models: p
            .models
            .into_iter()
            .map(|m| OpencodeCustomModel {
                id: m.slug,
                name: m.label,
                reasoning: true,
            })
            .collect(),
    }
}

pub struct OpencodeBackend {
    pub family: ProviderFamily,
}

impl OpencodeBackend {
    fn is_mimo(&self) -> bool {
        matches!(self.family, ProviderFamily::Mimo)
    }
}

impl CustomProviderBackend for OpencodeBackend {
    fn list(&self) -> Vec<CustomProvider> {
        let raw = if self.is_mimo() {
            opencode_config::read_mimo_custom_providers()
        } else {
            opencode_config::read_custom_providers()
        };
        raw.unwrap_or_default().into_iter().map(to_custom).collect()
    }

    fn upsert(&self, provider: CustomProvider) -> anyhow::Result<()> {
        let preset = provider.preset_key.is_some();
        let mapped = to_opencode(provider);
        if self.is_mimo() {
            opencode_config::upsert_mimo_custom_provider(&mapped, preset)
        } else {
            opencode_config::upsert_custom_provider(&mapped, preset)
        }
    }

    fn remove(&self, id: &str) -> anyhow::Result<()> {
        if self.is_mimo() {
            opencode_config::delete_mimo_custom_provider(id)
        } else {
            opencode_config::delete_custom_provider(id)
        }
    }
}

/// Identical to Codex's OpenAI-compatible `/v1/models` fetch.
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
) -> anyhow::Result<Vec<CustomProviderModel>> {
    super::codex::fetch_models(base_url, api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_custom_block() {
        let custom = CustomProvider {
            id: "hundun".to_string(),
            name: "Hundun".to_string(),
            preset_key: None,
            base_url: "http://x/v1".to_string(),
            api_key: "sk".to_string(),
            api_style: Some("responses".to_string()),
            headers: None,
            models: vec![CustomProviderModel {
                slug: "m".to_string(),
                label: "M".to_string(),
                effort_levels: Vec::new(),
            }],
            enabled_model_ids: None,
        };
        let oc = to_opencode(custom);
        assert_eq!(oc.npm, NPM_RESPONSES);
        assert!(oc.models[0].reasoning, "reasoning defaults on");
        let back = to_custom(oc);
        assert_eq!(back.api_style.as_deref(), Some("responses"));
        assert_eq!(back.preset_key, None);
        assert_eq!(back.models[0].slug, "m");
    }

    #[test]
    fn preset_block_maps_to_preset_key() {
        let oc = OpencodeCustomProvider {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            npm: String::new(),
            base_url: String::new(),
            api_key: "sk".to_string(),
            headers: Default::default(),
            models: Vec::new(),
        };
        let custom = to_custom(oc);
        assert_eq!(custom.preset_key.as_deref(), Some("deepseek"));
    }
}
