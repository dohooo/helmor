//! Persisted Local LLM settings + the shapes the manager reports back
//! to the frontend.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::SETTINGS_KEY;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub enabled: bool,
    /// Absolute path to a `.gguf` on disk. Empty = no model selected.
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// Per-entry runtime context overrides (`-c` value). Keyed by
    /// catalog entry id, or `custom:<absolute-path>` for user GGUFs.
    /// Absent entry = use the hardware-aware default.
    #[serde(default)]
    pub context_overrides: std::collections::HashMap<String, u32>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            model: String::new(),
            auto_start: true,
            context_overrides: std::collections::HashMap::new(),
        }
    }
}

/// Connection params for the running `llama-server`. The Voice Pilot
/// frontend POSTs OpenAI-style chat completions directly at this URL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub url: String,
    pub token: String,
    pub api_model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub runtime_found: bool,
    pub runtime_path: Option<String>,
    pub starting: bool,
    pub running: bool,
    pub model: String,
    pub api_model: String,
    pub context_size: u32,
    pub gpu_layers: u32,
    pub reasoning_mode: String,
    pub endpoint: Option<String>,
    pub last_error: Option<String>,
}

pub fn load_settings() -> Settings {
    crate::settings::load_setting_json::<Settings>(SETTINGS_KEY)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Switch the model the bundled `llama-server` should load. Caller is
/// responsible for restarting the server if it's running. Trims the
/// stored value so a trailing whitespace pasted by the user doesn't
/// leak into every downstream consumer (path comparison, GGUF inspect,
/// llama-server `--model` arg).
pub fn set_active_model_path(path: String) -> Result<()> {
    let mut settings = load_settings();
    settings.model = path.trim().to_string();
    crate::settings::upsert_setting_json(SETTINGS_KEY, &settings)
        .context("persist Local LLM model selection")?;
    Ok(())
}

pub(super) fn normalize_model(model: &str) -> String {
    model.trim().to_string()
}

const fn default_true() -> bool {
    true
}
