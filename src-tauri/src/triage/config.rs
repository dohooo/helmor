//! Triage config persisted as a JSON blob in the settings table.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::models::settings as settings_store;

const SETTINGS_KEY: &str = "app.triage_config";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageConfig {
    #[serde(default)]
    pub enabled: bool,
    /// False = only manual `Run now` fires a tick.
    #[serde(default = "default_auto_run")]
    pub auto_run: bool,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub max_per_tick: u32,
}

fn default_auto_run() -> bool {
    true
}

impl Default for TriageConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_run: true,
            system_prompt: String::new(),
            max_per_tick: 5,
        }
    }
}

pub fn load_config() -> Result<TriageConfig> {
    let raw = settings_store::load_setting_value(SETTINGS_KEY)?;
    let Some(raw) = raw else {
        return Ok(TriageConfig::default());
    };
    let mut cfg: TriageConfig = serde_json::from_str(&raw).unwrap_or_default();
    if cfg.max_per_tick == 0 {
        cfg.max_per_tick = 5;
    }
    Ok(cfg)
}

pub fn save_config(config: &TriageConfig) -> Result<()> {
    let json = serde_json::to_string(config).context("serialize triage config")?;
    settings_store::upsert_setting_value(SETTINGS_KEY, &json)?;
    Ok(())
}
