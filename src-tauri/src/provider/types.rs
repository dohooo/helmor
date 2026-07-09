//! Unified custom-provider config types. Mirror of frontend `lib/provider-config.ts`.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderFamily {
    Claude,
    Codex,
    Opencode,
    Kimi,
}

impl ProviderFamily {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            "kimi" => Some(Self::Kimi),
            _ => None,
        }
    }
}



#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelLimit {
    pub context: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    #[serde(default, alias = "cache_read", skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, alias = "cache_write", skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    #[serde(
        default,
        alias = "context_over_200k",
        skip_serializing_if = "Option::is_none"
    )]
    pub context_over_200k: Option<Box<ModelCost>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelModalities {
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub output: Vec<String>,
}

/// `true` | `{ field: "reasoning" | "reasoning_content" | "reasoning_details" }`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum InterleavedConfig {
    Flag(bool),
    Object { field: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ModelStatus {
    #[serde(rename = "alpha")]
    Alpha,
    #[serde(rename = "beta")]
    Beta,
    #[serde(rename = "deprecated")]
    Deprecated,
    #[serde(rename = "active")]
    Active,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderModel {
    /// Wire model name, sent verbatim to the endpoint.
    pub slug: String,
    #[serde(default)]
    pub label: String,
    /// Non-empty ⟺ the composer shows an effort switch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effort_levels: Vec<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<ModelLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModelModalities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ModelStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interleaved: Option<InterleavedConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variants: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Some → built-in preset (base URL pinned). None → manual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_key: Option<String>,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    /// OpenCode: "chat" | "responses". Claude: "anthropic" (default) | "vertex".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_style: Option<String>,
    /// Vertex-type Claude providers (`api_style == "vertex"`) only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertex_project_id: Option<String>,
    /// CLOUD_ML_REGION; empty → "global".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertex_region: Option<String>,
    /// "token" (default — `api_key` holds the gateway token) | "keychain".
    /// Keychain item names are fixed (see `claude::VERTEX_KEYCHAIN_SERVICE`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertex_auth_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub models: Vec<CustomProviderModel>,
    /// Codex: enabled model slugs (`None` = all). Unused for merged families.
    #[serde(default)]
    pub enabled_model_ids: Option<Vec<String>>,
}

impl CustomProvider {
    pub fn base_url(&self) -> &str {
        self.base_url.trim()
    }
    pub fn id(&self) -> &str {
        self.id.trim()
    }
    pub fn is_usable(&self) -> bool {
        !self.id().is_empty() && !self.base_url().is_empty()
    }
}

/// `None` = everything enabled.
pub fn is_enabled(enabled: Option<&[String]>, slug: &str) -> bool {
    match enabled {
        None => true,
        Some(ids) => ids.iter().any(|id| id == slug),
    }
}
