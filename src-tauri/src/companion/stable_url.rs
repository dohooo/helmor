//! Persistence for the stable (named-tunnel) companion URL.
//!
//! When the user allocates a permanent `remote-<random>.helmor.ai` hostname we
//! persist everything needed to bring the same tunnel back up on the next app
//! launch — so a paired phone keeps working at a fixed URL across restarts.
//! Its mere presence is the auto-start signal (see `lib.rs` setup).

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::models::settings;

const KEY: &str = "app.companion_stable_url";

/// Everything needed to re-run the named tunnel + revoke the hostname later.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StableUrl {
    /// Registry device id (used to revoke the hostname).
    pub device_id: String,
    /// `remote-<random>.helmor.ai`.
    pub hostname: String,
    /// Registry revocation secret.
    pub secret: String,
    /// cloudflared named-tunnel UUID.
    pub tunnel_uuid: String,
    /// Path to the tunnel credentials JSON (`~/.cloudflared/<uuid>.json`).
    pub creds_path: String,
}

pub fn load() -> Result<Option<StableUrl>> {
    settings::load_setting_json::<StableUrl>(KEY)
}

pub fn save(value: &StableUrl) -> Result<()> {
    settings::upsert_setting_json(KEY, value)
}

pub fn clear() -> Result<()> {
    settings::delete_setting_value(KEY)
}
