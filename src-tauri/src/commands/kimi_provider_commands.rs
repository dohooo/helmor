//! Tauri command for the Kimi "Models" picker (composer model grouping).
//! Custom-provider CRUD now goes through the unified `provider_commands`
//! (family = "kimi") — Kimi is a file-backed provider like OpenCode.

use super::common::{run_blocking, CmdResult};
use crate::provider::kimi::{self, KimiProviderConfig};

#[tauri::command]
pub async fn get_kimi_provider_config() -> CmdResult<KimiProviderConfig> {
    run_blocking(kimi::read_provider_config).await
}
