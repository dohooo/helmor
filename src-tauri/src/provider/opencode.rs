//! OpenCode custom-provider backend. File-backed; list/upsert/remove
//! delegate to `opencode_config`.

use super::opencode_config::{self, OpencodeCustomModel, OpencodeCustomProvider};
use super::types::{CustomProvider, CustomProviderModel};
use super::CustomProviderBackend;

const NPM_CHAT: &str = "@ai-sdk/openai-compatible";
const NPM_RESPONSES: &str = "@ai-sdk/openai";

fn to_custom(p: OpencodeCustomProvider) -> CustomProvider {
    // Registry presets (apiKey-only) never carry `npm`; manual providers always
    // do. A freshly-added manual slot starts with an empty baseURL, so key off
    // `npm` — else it'd be misread as a preset and lose its Base URL field.
    let is_preset = p.npm.trim().is_empty();
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
                reasoning: Some(m.reasoning),
                tool_call: Some(m.tool_call),
                temperature: Some(m.temperature),
                attachment: Some(m.attachment),
                limit: m.limit,
                modalities: m.modalities,
                cost: m.cost,
                family: m.family,
                release_date: m.release_date,
                status: m.status,
                interleaved: m.interleaved,
                variants: m.variants,
            })
            .collect(),
        enabled_model_ids: None,
        ..Default::default()
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

                reasoning: m.reasoning.unwrap_or(true),
                tool_call: m.tool_call.unwrap_or(false),
                temperature: m.temperature.unwrap_or(false),
                attachment: m.attachment.unwrap_or(false),
                family: m.family,
                release_date: m.release_date,
                status: m.status,
                cost: m.cost,
                interleaved: m.interleaved,
                variants: m.variants,
                limit: m.limit,
                modalities: m.modalities,
            })
            .collect(),
    }
}

pub struct OpencodeBackend;

impl CustomProviderBackend for OpencodeBackend {
    fn list(&self) -> Vec<CustomProvider> {
        opencode_config::read_custom_providers()
            .unwrap_or_default()
            .into_iter()
            .map(to_custom)
            .collect()
    }

    fn upsert(&self, provider: CustomProvider) -> anyhow::Result<()> {
        let preset = provider.preset_key.is_some();
        let mapped = to_opencode(provider);
        opencode_config::upsert_custom_provider(&mapped, preset)
    }

    fn remove(&self, id: &str) -> anyhow::Result<()> {
        opencode_config::delete_custom_provider(id)
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
                ..Default::default()
            }],
            enabled_model_ids: None,
            ..Default::default()
        };
        let oc = to_opencode(custom);
        assert_eq!(oc.npm, NPM_RESPONSES);
        assert!(oc.models[0].reasoning, "reasoning defaults on");
        let back = to_custom(oc);
        assert_eq!(back.api_style.as_deref(), Some("responses"));
        assert_eq!(back.preset_key, None);
        assert_eq!(back.models[0].slug, "m");
        assert_eq!(back.models[0].reasoning, Some(true));
        assert_eq!(back.models[0].tool_call, Some(false));
        assert_eq!(back.models[0].temperature, Some(false));
        assert_eq!(back.models[0].attachment, Some(false));
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

    #[test]
    fn fresh_manual_block_without_base_url_stays_manual() {
        // Regression: a just-added manual slot has no baseURL yet but does carry
        // `npm`. It must stay manual so the card keeps showing the Base URL field.
        let oc = OpencodeCustomProvider {
            id: "a1b2c3d4".to_string(),
            name: String::new(),
            npm: NPM_CHAT.to_string(),
            base_url: String::new(),
            api_key: String::new(),
            headers: Default::default(),
            models: Vec::new(),
        };
        assert_eq!(to_custom(oc).preset_key, None);
    }

    #[test]
    fn api_silent_fields_fall_back_to_defaults() {
        let custom = CustomProvider {
            id: "sparse".to_string(),
            name: "Sparse".to_string(),
            preset_key: None,
            base_url: "https://sparse.example.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            api_style: Some("chat".to_string()),
            headers: None,
            models: vec![CustomProviderModel {
                slug: "m".to_string(),
                label: "M".to_string(),
                effort_levels: Vec::new(),
                ..Default::default()
            }],
            enabled_model_ids: None,
        };
        let oc = to_opencode(custom);
        let m = &oc.models[0];
        assert!(m.reasoning);
        assert!(!m.tool_call);
        assert!(!m.temperature);
        assert!(!m.attachment);
        assert!(m.limit.is_none());
        assert!(m.modalities.is_none());
        assert!(m.cost.is_none());
    }

    #[test]
    fn api_fields_override_defaults() {
        use crate::provider::types::{ModelLimit, ModelModalities};

        let custom = CustomProvider {
            id: "rich".to_string(),
            name: "Rich".to_string(),
            preset_key: None,
            base_url: "https://rich.example.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            api_style: Some("chat".to_string()),
            headers: None,
            models: vec![CustomProviderModel {
                slug: "m".to_string(),
                label: "M".to_string(),
                effort_levels: Vec::new(),
                reasoning: Some(false),
                tool_call: Some(true),
                temperature: Some(true),
                attachment: Some(true),
                limit: Some(ModelLimit {
                    context: 1_000_000,
                    output: 384_000,
                }),
                modalities: Some(ModelModalities {
                    input: vec!["text".to_string(), "image".to_string()],
                    output: vec!["text".to_string()],
                }),
                ..Default::default()
            }],
            enabled_model_ids: None,
        };
        let oc = to_opencode(custom);
        let m = &oc.models[0];
        assert!(!m.reasoning);
        assert!(m.tool_call);
        assert!(m.temperature);
        assert!(m.attachment);
        assert_eq!(m.limit.as_ref().unwrap().context, 1_000_000);
        assert_eq!(m.modalities.as_ref().unwrap().input, vec!["text", "image"]);
    }
}
