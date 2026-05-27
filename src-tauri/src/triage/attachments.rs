//! Persistent attachment store + `helmor-attachment://` resolver.
//!
//! Two-stage life:
//!   - Fetcher stages files under `<data>/triage/attachments-staging/<source>/<safe(candidate_id)>/`
//!   - workspace_factory moves the chosen ones into
//!     `<data>/triage/attachments/<workspace_id>/`, which the
//!     `helmor-attachment` Tauri protocol handler serves.
//!
//! Staging is swept when the owning candidate row is deleted; the
//! workspace-scoped store is swept on archive.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

const STORE_SUBDIR: &str = "triage/attachments";
const STAGING_SUBDIR: &str = "triage/attachments-staging";
const ATTACHMENT_URL_SCHEME: &str = "helmor-attachment";

/// Cap on bytes inlined into a vision block.
pub const INLINE_PREVIEW_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Root of the persistent (workspace-scoped) store.
pub fn store_root() -> Result<PathBuf> {
    Ok(crate::data_dir::data_dir()?.join(STORE_SUBDIR))
}

fn store_dir_for_workspace(workspace_id: &str) -> Result<PathBuf> {
    let dir = store_root()?.join(workspace_id);
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    Ok(dir)
}

fn staging_root() -> Result<PathBuf> {
    Ok(crate::data_dir::data_dir()?.join(STAGING_SUBDIR))
}

/// Per-candidate staging dir. Created on demand.
pub fn staging_dir(source: &str, candidate_id: &str) -> Result<PathBuf> {
    let dir = staging_root()?
        .join(sanitize_segment(source))
        .join(sanitize_segment(candidate_id));
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    Ok(dir)
}

/// Path to write a single attachment under a candidate's staging dir.
/// Caller writes the bytes. Idempotent (overwrites).
pub fn staging_path(source: &str, candidate_id: &str, filename: &str) -> Result<PathBuf> {
    Ok(staging_dir(source, candidate_id)?.join(sanitize_segment(filename)))
}

/// Resolve `helmor-attachment://<workspace_id>/<filename>` for the Tauri protocol handler in `lib.rs`.
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

/// Move a staged file into a workspace's persistent store.
/// Returns the `helmor-attachment://` URL + absolute path the caller
/// can render into priming markdown.
pub fn move_into_store(src: &Path, workspace_id: &str) -> Result<MovedAttachment> {
    let filename = src
        .file_name()
        .and_then(|s| s.to_str())
        .map(sanitize_segment)
        .ok_or_else(|| anyhow::anyhow!("source path has no filename: {}", src.display()))?;
    let dest_dir = store_dir_for_workspace(workspace_id)?;
    let dest = dest_dir.join(&filename);
    // `rename` works in-FS; cross-FS falls back to copy + remove.
    if let Err(_e) = std::fs::rename(src, &dest) {
        std::fs::copy(src, &dest)
            .with_context(|| format!("copy {} -> {}", src.display(), dest.display()))?;
        let _ = std::fs::remove_file(src);
    }
    Ok(MovedAttachment {
        url: format!("{ATTACHMENT_URL_SCHEME}://{workspace_id}/{filename}"),
        absolute_path: dest,
        filename,
    })
}

/// Result of `move_into_store`.
#[derive(Debug, Clone)]
pub struct MovedAttachment {
    pub url: String,
    pub absolute_path: PathBuf,
    pub filename: String,
}

/// Read a staged image into a base64 vision block. `Ok(None)` when the
/// file is missing, too large, or has an unrecognised image extension.
pub fn inline_preview(path: &Path) -> Result<Option<InlinePreview>> {
    let mime = match guess_image_mime(path) {
        Some(m) => m,
        None => return Ok(None),
    };
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() || meta.len() > INLINE_PREVIEW_MAX_BYTES {
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .with_context(|| format!("read attachment for inline preview: {}", path.display()))?;
    Ok(Some(InlinePreview {
        data_base64: BASE64_STANDARD.encode(&bytes),
        mime_type: mime.into(),
    }))
}

/// Vision payload for the triage tick.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InlinePreview {
    #[serde(rename = "dataBase64")]
    pub data_base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

fn guess_image_mime(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())?
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// GC: drop a workspace's persistent attachment dir on archive.
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

/// GC: drop a candidate's staging dir when the row is removed.
pub fn sweep_candidate_staging(source: &str, candidate_id: &str) {
    let Ok(dir) = staging_dir(source, candidate_id) else {
        return;
    };
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                error = %error,
                source,
                candidate_id,
                path = %dir.display(),
                "triage: attachment staging sweep failed"
            );
        }
    }
}

/// FS-safe segment: alnum + `_-.`, others → `_`, capped 80 chars.
fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.len() > 80 {
        out.truncate(80);
    }
    out
}
