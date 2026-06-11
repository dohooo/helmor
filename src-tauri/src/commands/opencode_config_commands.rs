//! Tauri commands for the opencode custom-providers form.

use super::common::{run_blocking, CmdResult};
use crate::agents::opencode_config::{self, OpencodeCustomProvider};

#[tauri::command]
pub async fn get_opencode_custom_providers() -> CmdResult<Vec<OpencodeCustomProvider>> {
    crate::agents::provider_capabilities::ensure_agent_provider_enabled("opencode")?;
    run_blocking(opencode_config::read_custom_providers).await
}

#[tauri::command]
pub async fn upsert_opencode_custom_provider(
    provider: OpencodeCustomProvider,
    preset: bool,
) -> CmdResult<()> {
    crate::agents::provider_capabilities::ensure_agent_provider_enabled("opencode")?;
    run_blocking(move || opencode_config::upsert_custom_provider(&provider, preset)).await
}

#[tauri::command]
pub async fn delete_opencode_custom_provider(id: String) -> CmdResult<()> {
    crate::agents::provider_capabilities::ensure_agent_provider_enabled("opencode")?;
    run_blocking(move || opencode_config::delete_custom_provider(&id)).await
}
