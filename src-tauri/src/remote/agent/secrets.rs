//! Per-provider API key store. Lives at
//! `$HOME/.helmor/server/secrets.json` on the daemon. Mode 0600 on
//! Unix; atomic `.tmp` rename so a crash mid-write doesn't corrupt
//! the previous file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Per-provider auth captured in `$HOME/.helmor/server/secrets.json`.
/// Today the only consumer is the sidecar's `cursor` provider — but
/// the shape is provider-keyed so future Claude / Codex custom-proxy
/// flows can land alongside without a wire change.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderSecret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) base_url: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub(super) struct SecretsStore {
    /// Provider name → per-provider secret. Keyed by the same
    /// string the desktop passes in `AgentSetAuthParams.provider`.
    #[serde(default)]
    pub(super) providers: HashMap<String, ProviderSecret>,
}

/// `$HOME/.helmor/server/secrets.json`. Returns `None` if `$HOME`
/// isn't resolvable (containers without a home dir); callers degrade
/// to in-memory-only behaviour.
pub(super) fn default_secrets_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|home| {
            PathBuf::from(home)
                .join(".helmor")
                .join("server")
                .join("secrets.json")
        })
}

pub(super) fn load_secrets(path: &Path) -> Result<SecretsStore> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SecretsStore::default());
        }
        Err(err) => {
            return Err(err).context("read secrets.json");
        }
    };
    if raw.trim().is_empty() {
        return Ok(SecretsStore::default());
    }
    serde_json::from_str(&raw).with_context(|| format!("parse secrets at {}", path.display()))
}

pub(super) fn save_secrets(path: &Path, store: &SecretsStore) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create secrets dir at {}", parent.display()))?;
    }
    // Atomic write through a `.tmp` sibling: a crash mid-write
    // leaves the previous file intact. Mode 0600 only fires on
    // Unix; Windows falls through to the OS default (the daemon is
    // Unix-only today but this keeps the code portable).
    let tmp = path.with_extension("json.tmp");
    let serialised = serde_json::to_string_pretty(store).context("serialise secrets store")?;
    std::fs::write(&tmp, serialised).with_context(|| format!("write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .context("chmod 0600 secrets tmp")?;
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("rename {} → {}", tmp.display(), path.display()))?;
    Ok(())
}
