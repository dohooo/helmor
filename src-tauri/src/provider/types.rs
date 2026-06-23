//! Unified custom-provider config types. Mirror of frontend `lib/provider-config.ts`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderFamily {
    Claude,
    Codex,
    Opencode,
    Mimo,
    Kimi,
}

impl ProviderFamily {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            "mimo" => Some(Self::Mimo),
            "kimi" => Some(Self::Kimi),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderModel {
    /// Wire model name, sent verbatim to the endpoint.
    pub slug: String,
    #[serde(default)]
    pub label: String,
    /// Non-empty ⟺ the composer shows an effort switch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effort_levels: Vec<String>,
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
    /// OpenCode/MiMo only — "chat" | "responses".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_style: Option<String>,
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
