//! GC for `<data_dir>/cache/paste/`.
//!
//! ```text
//! cache/paste/<session_id>/paste-<uuid>.<ext>
//! ```
//!
//! Bucket id is either a live `sessions.id` or a provisional UUID
//! pre-allocated by the composer (StartPage flow); a successful submit
//! reuses the provisional id as `sessions.id`, no rename. Sweep diffs
//! disk against `sessions.id` and reclaims unmatched buckets older than
//! [`UNCLAIMED_GRACE`] — the grace window protects unsubmitted
//! StartPage drafts whose paste refs live in localStorage (invisible to
//! the sweeper).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};

use crate::data_dir;
use crate::models::db;

/// Window granted to unclaimed buckets before reclamation. Covers the
/// "paste → maybe submit later" gap for StartPage drafts that the
/// sweeper can't see via the DB.
const UNCLAIMED_GRACE: Duration = Duration::from_secs(5 * 24 * 60 * 60);

/// Recognised bucket name: `[0-9a-f-]` up to 64 chars. Permissive on
/// UUID format, strict on traversal / casing.
fn is_managed_session_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && !name.contains('/')
        && !name.contains(std::path::MAIN_SEPARATOR)
}

/// Sweep orphan buckets. Returns bytes freed. Best-effort: I/O errors
/// log and are swallowed.
///
/// Ordering matters: `read_dir` runs **before** the sessions query so a
/// session created between the two reads (and its just-written bucket)
/// stays invisible to this pass instead of being wiped.
pub fn sweep() -> Result<u64> {
    let dir = data_dir::paste_cache_dir()?;

    let sweep_start = SystemTime::now();

    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(
                error = %err,
                dir = %dir.display(),
                "paste-cache sweep: read_dir failed",
            );
            return Ok(0);
        }
    };

    // Materialise listing before the DB query (see fn doc).
    let snapshot: Vec<_> = entries.flatten().collect();

    let live_sessions = match load_live_session_ids() {
        Ok(set) => set,
        Err(err) => {
            tracing::warn!(error = %err, "paste-cache sweep: sessions query failed; skipping");
            return Ok(0);
        }
    };

    let mut freed: u64 = 0;
    let mut removed_dirs: usize = 0;

    for entry in snapshot {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Top-level files (legacy flat layout, .DS_Store, …) are out of scope.
        if !metadata.is_dir() {
            continue;
        }

        if !is_managed_session_dir_name(name) {
            continue;
        }
        if live_sessions.contains(name) {
            continue;
        }

        // Race guard: bucket created during this sweep.
        if dir_mtime_is_after(&metadata, sweep_start) {
            continue;
        }

        // Unclaimed-draft grace window.
        if !dir_mtime_is_before(&metadata, sweep_start - UNCLAIMED_GRACE) {
            continue;
        }

        let bytes = dir_size(&path);
        match fs::remove_dir_all(&path) {
            Ok(()) => {
                freed += bytes;
                removed_dirs += 1;
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    path = %path.display(),
                    "paste-cache sweep: remove_dir_all failed",
                );
            }
        }
    }

    if removed_dirs > 0 {
        tracing::info!(
            removed_session_dirs = removed_dirs,
            freed_bytes = freed,
            "paste-cache sweep done",
        );
    }
    Ok(freed)
}

fn load_live_session_ids() -> Result<HashSet<String>> {
    let conn = db::read_conn()?;
    let mut stmt = conn
        .prepare_cached("SELECT id FROM sessions")
        .context("prepare sessions id scan")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .context("run sessions id scan")?;
    let mut out = HashSet::new();
    for row in rows {
        out.insert(row.context("read sessions.id")?);
    }
    Ok(out)
}

fn dir_mtime_is_after(metadata: &fs::Metadata, cutoff: SystemTime) -> bool {
    metadata.modified().map(|m| m > cutoff).unwrap_or(false)
}

/// Unreadable mtime → `false` (preserve, don't gamble on deletion).
fn dir_mtime_is_before(metadata: &fs::Metadata, cutoff: SystemTime) -> bool {
    metadata.modified().map(|m| m < cutoff).unwrap_or(false)
}

fn dir_size(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// Bucket path for a fresh paste. Bails on missing / malformed ids
/// instead of falling back, so the sweeper can always reason about
/// ownership.
pub fn destination_dir(root: &Path, session_id: &str) -> Result<PathBuf> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        bail!("paste-cache: session_id is required (got empty string)");
    }
    if !is_managed_session_dir_name(trimmed) {
        bail!(
            "paste-cache: rejecting malformed session_id (len={}, sample prefix={:?})",
            trimmed.len(),
            &trimmed.chars().take(8).collect::<String>(),
        );
    }
    Ok(root.join(trimmed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::time::Duration;

    #[test]
    fn destination_uses_session_subdir_when_id_safe() {
        let root = Path::new("/tmp/paste-cache");
        let dest = destination_dir(root, "a1b2c3d4-1111-2222-3333-444455556666").unwrap();
        assert_eq!(dest, root.join("a1b2c3d4-1111-2222-3333-444455556666"));
    }

    #[test]
    fn destination_rejects_empty_id() {
        let root = Path::new("/tmp/paste-cache");
        assert!(destination_dir(root, "").is_err());
        assert!(destination_dir(root, "   ").is_err());
    }

    #[test]
    fn destination_rejects_unsafe_ids() {
        let root = Path::new("/tmp/paste-cache");
        assert!(destination_dir(root, "../escape").is_err());
        assert!(destination_dir(root, "session/with/slash").is_err());
        assert!(destination_dir(root, "UPPERCASE-NOT-UUID").is_err());
        let too_long: String = "a".repeat(65);
        assert!(destination_dir(root, &too_long).is_err());
    }

    #[test]
    fn is_managed_session_dir_name_accepts_uuid_v4() {
        assert!(is_managed_session_dir_name(
            "a1b2c3d4-1111-2222-3333-444455556666"
        ));
    }

    #[test]
    fn is_managed_session_dir_name_rejects_traversal_and_garbage() {
        assert!(!is_managed_session_dir_name(""));
        assert!(!is_managed_session_dir_name(".."));
        assert!(!is_managed_session_dir_name("README.md"));
        assert!(!is_managed_session_dir_name(".DS_Store"));
        assert!(!is_managed_session_dir_name("_unbound"));
        assert!(!is_managed_session_dir_name("paste-aaaa.png"));
    }

    #[test]
    fn dir_size_sums_recursively() {
        let dir = tempfile::tempdir().unwrap();
        File::create(dir.path().join("a.bin"))
            .unwrap()
            .write_all(&[0u8; 10])
            .unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        File::create(sub.join("b.bin"))
            .unwrap()
            .write_all(&[0u8; 25])
            .unwrap();
        assert_eq!(dir_size(dir.path()), 35);
    }

    #[test]
    fn dir_mtime_is_after_works_with_real_files() {
        let dir = tempfile::tempdir().unwrap();
        File::create(dir.path().join("x")).unwrap();
        let metadata = fs::metadata(dir.path()).unwrap();
        let past = SystemTime::now() - Duration::from_secs(3600);
        assert!(dir_mtime_is_after(&metadata, past));
        let future = SystemTime::now() + Duration::from_secs(3600);
        assert!(!dir_mtime_is_after(&metadata, future));
    }

    #[test]
    fn dir_mtime_is_before_inverts_correctly() {
        let dir = tempfile::tempdir().unwrap();
        File::create(dir.path().join("x")).unwrap();
        let metadata = fs::metadata(dir.path()).unwrap();
        let past = SystemTime::now() - Duration::from_secs(3600);
        let future = SystemTime::now() + Duration::from_secs(3600);
        assert!(!dir_mtime_is_before(&metadata, past));
        assert!(dir_mtime_is_before(&metadata, future));
    }

    #[test]
    fn unclaimed_grace_protects_recent_buckets() {
        let dir = tempfile::tempdir().unwrap();
        File::create(dir.path().join("paste-aaaa.png")).unwrap();
        let metadata = fs::metadata(dir.path()).unwrap();
        let cutoff = SystemTime::now() - UNCLAIMED_GRACE;
        assert!(!dir_mtime_is_before(&metadata, cutoff));
    }

    #[test]
    fn unclaimed_grace_is_five_days() {
        // Pin the policy: bare edit shouldn't silently change the
        // user-visible draft-protection window.
        assert_eq!(UNCLAIMED_GRACE, Duration::from_secs(5 * 24 * 60 * 60));
    }
}
