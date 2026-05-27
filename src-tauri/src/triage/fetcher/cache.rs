//! Payload files on disk under `cache/triage/`.
//!
//! `triage_candidate.payload_path` is stored relative to this root so
//! `HELMOR_DATA_DIR` moves and tests don't carry stale absolute paths.

use std::fs;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::data_dir;

const CACHE_KIND: &str = "triage";

pub fn cache_root() -> Result<PathBuf> {
    data_dir::cache_dir(CACHE_KIND)
}

pub fn write_payload(rel_path: &str, body: &str) -> Result<u64> {
    let root = cache_root()?;
    let full = root.join(rel_path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!("Failed to create triage cache subdir {}", parent.display())
        })?;
    }
    fs::write(&full, body)
        .with_context(|| format!("Failed to write triage payload {}", full.display()))?;
    Ok(body.len() as u64)
}

pub fn read_payload(rel_path: &str) -> Result<String> {
    let root = cache_root()?;
    let full = root.join(rel_path);
    fs::read_to_string(&full)
        .with_context(|| format!("Failed to read triage payload {}", full.display()))
}

pub fn delete_payload(rel_path: &str) -> Result<()> {
    let root = cache_root()?;
    let full = root.join(rel_path);
    if full.exists() {
        fs::remove_file(&full)
            .with_context(|| format!("Failed to remove triage payload {}", full.display()))?;
    }
    Ok(())
}

/// Sanitize a fragment for filesystem use; alnum + `_-`, max 80 chars.
pub fn safe_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(80));
    for c in input.chars().take(120) {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    if out.len() > 80 {
        out.truncate(80);
    }
    out
}

/// Ensure cache root exists at startup.
#[allow(dead_code)]
pub fn ensure_cache_root() -> Result<PathBuf> {
    cache_root()
}

/// Resolve a relative payload path under the cache root, validating it
/// stays inside the root (defense in depth — `payload_path` is fetcher-
/// written, but treat it as untrusted just in case a row got corrupted).
#[allow(dead_code)]
pub fn resolve_for_read(rel_path: &str) -> Result<PathBuf> {
    let root = cache_root()?.canonicalize().unwrap_or(cache_root()?);
    let full = root.join(rel_path);
    let canon = full.canonicalize().unwrap_or(full.clone());
    if !canon.starts_with(&root) {
        anyhow::bail!("triage cache path escapes root: {}", rel_path);
    }
    Ok(canon)
}

#[cfg(test)]
pub fn root_for_test() -> PathBuf {
    cache_root().expect("test cache root")
}

#[cfg(test)]
pub fn join_root(root: &Path, rel: &str) -> PathBuf {
    root.join(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_segment_keeps_alnum_underscore_dash() {
        assert_eq!(safe_segment("om_abc-123"), "om_abc-123");
        assert_eq!(safe_segment("om/abc 123"), "om_abc_123");
        assert_eq!(safe_segment(""), "_");
    }

    #[test]
    fn safe_segment_truncates_long_input() {
        let huge = "a".repeat(500);
        assert_eq!(safe_segment(&huge).len(), 80);
    }

    #[test]
    fn write_then_read_round_trips() {
        let _env = crate::testkit::TestEnv::new("triage_cache_rw");
        let path = "test_dir/sample.md";
        let body = "hello triage";
        let bytes = write_payload(path, body).unwrap();
        assert_eq!(bytes as usize, body.len());
        assert_eq!(read_payload(path).unwrap(), body);
        delete_payload(path).unwrap();
    }

    #[test]
    fn delete_payload_is_idempotent() {
        let _env = crate::testkit::TestEnv::new("triage_cache_idem");
        delete_payload("never_existed.md").unwrap();
    }
}
