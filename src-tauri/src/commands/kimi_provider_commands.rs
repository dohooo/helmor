//! Tauri commands for the Kimi custom-providers + model picker UI. Thin
//! wrappers over `agents::kimi_config`, which delegates to the `kimi provider`
//! CLI.

use super::common::{run_blocking, CmdResult};
use crate::agents::kimi_config::{self, CustomProviderInput, KimiProviderConfig};

#[tauri::command]
pub async fn get_kimi_provider_config() -> CmdResult<KimiProviderConfig> {
    run_blocking(kimi_config::read_provider_config).await
}

/// Add a raw OpenAI/Anthropic-compatible endpoint (base URL + key + model)
/// straight into `config.toml` — the `kimi provider` CLI has no command for it.
#[tauri::command]
pub async fn add_kimi_custom_provider(input: CustomProviderInput) -> CmdResult<()> {
    run_blocking(move || kimi_config::add_custom_provider(&input)).await
}

#[tauri::command]
pub async fn add_kimi_catalog_provider(provider_id: String, api_key: String) -> CmdResult<()> {
    run_blocking(move || kimi_config::add_catalog_provider(&provider_id, &api_key)).await
}

#[tauri::command]
pub async fn add_kimi_registry(url: String, api_key: String) -> CmdResult<()> {
    run_blocking(move || kimi_config::add_registry(&url, &api_key)).await
}

#[tauri::command]
pub async fn remove_kimi_provider(provider_id: String) -> CmdResult<()> {
    run_blocking(move || kimi_config::remove_provider(&provider_id)).await
}
