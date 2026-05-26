//! Persistent attachment store + custom-protocol resolver.
//!
//! Layer-2 of triage no longer downloads attachments inline (the LLM
//! lost the `*_save_image / *_save_attachment` tools when the
//! per-platform host bridge was removed). What remains here:
//!
//!   1. `resolve_attachment_url` — backs the `helmor-attachment://`
//!      custom protocol registered in `lib.rs`. Existing rows in the
//!      DB that point at a `helmor-attachment://` URL keep rendering.
//!   2. `sweep_workspace_store` — called by the archive lifecycle so
//!      dropped workspaces don't leak files.
//!
//! Anything else (per-tick staging, base64 inline previews, MIME
//! sniffing) was bound to the old LLM flow and is gone.

use std::path::PathBuf;

use anyhow::{Context, Result};

const STORE_SUBDIR: &str = "triage/attachments";
const ATTACHMENT_URL_SCHEME: &str = "helmor-attachment";

/// Root of the persistent attachment store. Lives under helmor's data
/// dir, NOT inside any workspace.
pub fn store_root() -> Result<PathBuf> {
    Ok(crate::data_dir::data_dir()?.join(STORE_SUBDIR))
}

fn store_dir_for_workspace(workspace_id: &str) -> Result<PathBuf> {
    let dir = store_root()?.join(workspace_id);
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    Ok(dir)
}

/// Resolve `helmor-attachment://<workspace_id>/<filename>` to an
/// absolute path in the persistent store. `Ok(None)` for malformed
/// inputs or missing files. Used by the Tauri protocol handler in
/// `lib.rs`.
pub fn resolve_attachment_url(url: &str) -> Result<Option<PathBuf>> {
    let prefix = format!("{ATTACHMENT_URL_SCHEME}://");
    let rest = match url.strip_prefix(&prefix) {
        Some(r) => r,
        None => return Ok(None),
    };
    let (workspace_id, filename) = match rest.split_once('/') {
        Some(parts) => parts,
        None => return Ok(None),
    };
    if workspace_id.is_empty() || filename.is_empty() {
        return Ok(None);
    }
    if workspace_id.contains("..") || filename.contains("..") || filename.contains('/') {
        return Ok(None);
    }
    let path = store_root()?.join(workspace_id).join(filename);
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(path))
}

/// GC: remove the persistent attachment dir for a workspace. Called
/// from the archive lifecycle so dropped workspaces don't leak files.
pub fn sweep_workspace_store(workspace_id: &str) {
    let Ok(dir) = store_dir_for_workspace(workspace_id) else {
        return;
    };
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                error = %error,
                workspace_id,
                path = %dir.display(),
                "triage: attachment store sweep failed"
            );
        }
    }
}
