//! Tauri commands for the MiMo Code custom-providers form. Mirrors
//! `opencode_config_commands` — same JSON shape, MiMo's own config file
//! (`~/.config/mimocode/mimocode.json`).

use super::common::{run_blocking, CmdResult};
use crate::agents::opencode_config::{self, OpencodeCustomProvider};

#[tauri::command]
pub async fn get_mimo_custom_providers() -> CmdResult<Vec<OpencodeCustomProvider>> {
    run_blocking(opencode_config::read_mimo_custom_providers).await
}

#[tauri::command]
pub async fn upsert_mimo_custom_provider(
    provider: OpencodeCustomProvider,
    preset: bool,
) -> CmdResult<()> {
    run_blocking(move || opencode_config::upsert_mimo_custom_provider(&provider, preset)).await
}

#[tauri::command]
pub async fn delete_mimo_custom_provider(id: String) -> CmdResult<()> {
    run_blocking(move || opencode_config::delete_mimo_custom_provider(&id)).await
}
