//! Per-tick attachment staging.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context, Result};
use base64::Engine;

const STAGING_SUBDIR: &str = "triage/attachments-staging";
const WORKSPACE_SUBDIR: &str = ".helmor/triage-attachments";
/// Files larger than this skip the inline-to-LLM path — we still keep
/// the staged copy so the downstream cloud agent can see it via the
/// workspace dir, but the local LLM only gets a text breadcrumb.
const INLINE_PREVIEW_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub struct InlinePreview {
    pub data_base64: String,
    pub mime_type: String,
}

/// Read a staged file and produce a base64 preview the local LLM can
/// consume as an `ImageContent` block. Returns `Ok(None)` when the file
/// is over `INLINE_PREVIEW_MAX_BYTES` or its extension isn't an image
/// type llama-cpp's vision pipeline supports.
pub fn inline_preview(path: &Path) -> Result<Option<InlinePreview>> {
    let metadata = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    if metadata.len() > INLINE_PREVIEW_MAX_BYTES {
        return Ok(None);
    }
    let Some(mime) = guess_image_mime(path) else {
        return Ok(None);
    };
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(InlinePreview {
        data_base64,
        mime_type: mime,
    }))
}

fn guess_image_mime(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)?;
    Some(
        match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => return None,
        }
        .to_string(),
    )
}

pub struct StagedAttachment {
    pub id: String,
    pub path: PathBuf,
    pub filename: String,
}

pub fn staging_root() -> Result<PathBuf> {
    Ok(crate::data_dir::data_dir()?.join(STAGING_SUBDIR))
}

pub fn staging_dir_for(tick_id: &str) -> Result<PathBuf> {
    let dir = staging_root()?.join(tick_id);
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    Ok(dir)
}

// Allocate a path under the tick's staging dir; caller writes the content.
pub fn reserve_attachment(tick_id: &str, extension: Option<&str>) -> Result<StagedAttachment> {
    let id = uuid::Uuid::new_v4().to_string();
    let ext = extension
        .map(|e| e.trim_start_matches('.'))
        .filter(|e| !e.is_empty() && is_safe_ext(e));
    let filename = match ext {
        Some(ext) => format!("{id}.{ext}"),
        None => id.clone(),
    };
    let dir = staging_dir_for(tick_id)?;
    Ok(StagedAttachment {
        id,
        path: dir.join(&filename),
        filename,
    })
}

pub fn find_attachment(attachment_id: &str) -> Result<Option<PathBuf>> {
    let root = staging_root()?;
    if !root.exists() {
        return Ok(None);
    }
    for tick in std::fs::read_dir(&root).context("read staging root")? {
        let tick_path = tick?.path();
        if !tick_path.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&tick_path).context("read tick dir")? {
            let path = entry?.path();
            if path.file_stem().and_then(|s| s.to_str()) == Some(attachment_id) {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

pub struct MovedAttachment {
    pub workspace_relative_path: String,
    pub absolute_path: PathBuf,
    pub filename: String,
}

// Returns the workspace-relative path for use in the priming message.
pub fn move_into_workspace(
    attachment_id: &str,
    workspace_root: &std::path::Path,
) -> Result<MovedAttachment> {
    let staged = find_attachment(attachment_id)?
        .ok_or_else(|| anyhow!("attachment {attachment_id} not found in staging"))?;
    let filename = staged
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("invalid staged filename"))?
        .to_string();
    let dest_dir = workspace_root.join(WORKSPACE_SUBDIR);
    std::fs::create_dir_all(&dest_dir).with_context(|| format!("mkdir {}", dest_dir.display()))?;
    let dest = dest_dir.join(&filename);
    // Cross-device safe: rename, fall back to copy+remove.
    if std::fs::rename(&staged, &dest).is_err() {
        std::fs::copy(&staged, &dest).with_context(|| format!("copy {filename}"))?;
        let _ = std::fs::remove_file(&staged);
    }
    Ok(MovedAttachment {
        workspace_relative_path: format!("{WORKSPACE_SUBDIR}/{filename}"),
        absolute_path: dest,
        filename,
    })
}

// GC tick dirs older than `max_age`; run by scheduler after each tick.
pub fn sweep_stale_staging(max_age: Duration) {
    let Ok(root) = staging_root() else { return };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(max_age)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if mtime < cutoff {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn is_safe_ext(ext: &str) -> bool {
    ext.len() <= 12
        && ext
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
