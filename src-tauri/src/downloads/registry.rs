//! In-process registry for the generic downloads manager.
//!
//! Holds:
//!   * one row per `Asset.id` (status snapshot, derived from disk)
//!   * the active worker cancel flags (per id)
//!   * the set of frontend subscribers (`Channel<AssetEvent>`)
//!   * a reference to the host-app `AssetProvider` so `snapshot()`
//!     and `subscribe()` can rebuild the catalog without callers
//!     having to pass `assets` in every time
//!
//! Invariant: at most ONE worker per `Asset.id` is alive at any
//! time. `start()` is the only entry point that spawns a worker.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tauri::ipc::Channel;
use tauri::Manager;

use super::types::{Asset, AssetEvent, AssetEventKind, AssetState, AssetStatus};
use super::worker;

/// Business adapter — supplies the current catalog of `Asset`s the
/// manager should track. Implementations are typically zero-cost
/// (catalog is hardcoded in Rust), so the trait method can be called
/// on every snapshot without caching concerns.
pub trait AssetProvider: Send + Sync {
    fn assets(&self) -> Vec<Asset>;
}

#[derive(Default)]
struct Inner {
    /// Status by `Asset.id`. Re-derived from disk every time
    /// `snapshot()` runs (so manually placed files are picked up),
    /// except for ids that are currently active or pending cancel —
    /// those are owned by their worker.
    statuses: HashMap<String, AssetStatus>,
    /// Active worker cancel flags. Presence implies status ==
    /// Downloading. Worker drops its handle from this map on exit.
    active: HashMap<String, Arc<AtomicBool>>,
    /// Ids whose download was Cancelled (not Paused) by the user but
    /// whose worker hasn't yet observed the cancel flag. `emit()`
    /// filters out any incoming event for ids in this set so the
    /// worker's last gasp `Paused` doesn't undo the cancel reset.
    cancelling: HashSet<String>,
    /// Frontend event channels. We never explicitly unsubscribe —
    /// `Channel::send` returns Err for dead channels and we GC those
    /// on the next broadcast pass.
    subscribers: Vec<Channel<AssetEvent>>,
    /// Memoised reqwest client. Built lazily on first use so panel
    /// open doesn't pay for TLS handshakes the user may never trigger.
    http: Option<reqwest::Client>,
}

/// The actual manager. Wraps `Inner` in a Mutex and holds the
/// business-level `AssetProvider` that supplies the catalog of
/// downloadable artefacts.
pub struct DownloadsManager {
    provider: Arc<dyn AssetProvider>,
    inner: Mutex<Inner>,
}

impl DownloadsManager {
    pub fn new(provider: Arc<dyn AssetProvider>) -> Self {
        Self {
            provider,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Snapshot of every registered asset's current state. Disk is
    /// re-scanned on EVERY call (cheap — a handful of `stat` syscalls
    /// per asset) so files the user drops in by hand are picked up
    /// without restart. Active and cancelling ids are skipped so an
    /// in-flight worker's streaming progress isn't clobbered.
    pub fn snapshot(&self) -> Vec<AssetStatus> {
        let assets = self.provider.assets();
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        Self::refresh_from_disk_locked(&mut inner, &assets);
        let mut out: Vec<_> = inner.statuses.values().cloned().collect();
        out.sort_by(|a, b| a.entry_id.cmp(&b.entry_id));
        out
    }

    fn refresh_from_disk_locked(inner: &mut Inner, assets: &[Asset]) {
        for asset in assets {
            if inner.active.contains_key(&asset.id) {
                continue;
            }
            if inner.cancelling.contains(&asset.id) {
                continue;
            }
            inner
                .statuses
                .insert(asset.id.clone(), scan_asset_state(asset));
        }
    }

    /// Register a frontend event channel. Returns the initial snapshot
    /// so the caller can render without a separate `snapshot()` round
    /// trip.
    pub fn subscribe(&self, channel: Channel<AssetEvent>) -> Vec<AssetStatus> {
        // Snapshot BEFORE pushing the subscriber: the snapshot call
        // takes the lock, and we don't want subscribe() to deadlock
        // against itself.
        let initial = self.snapshot();
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.subscribers.push(channel);
        initial
    }

    /// Kick off a download for `asset_id`. No-op if it's already
    /// running or already complete. Resumes from `.part` automatically
    /// when present.
    pub fn start(&self, app: tauri::AppHandle, asset_id: &str) -> Result<()> {
        let asset = self
            .provider
            .assets()
            .into_iter()
            .find(|a| a.id == asset_id)
            .with_context(|| format!("unknown asset id: {asset_id}"))?;

        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            // Re-sync from disk first so we don't kick off a download
            // for an asset the user just dropped into the target dir.
            let all_assets = self.provider.assets();
            Self::refresh_from_disk_locked(&mut inner, &all_assets);
            // Reject (no-op) if a previous worker is still alive — either
            // mid-cancel teardown (would race over the `.part` and the
            // post-cancel delete could nuke the new download) or simply
            // already downloading / completed. The user can retry once
            // the cancellation has settled.
            if inner.active.contains_key(asset_id) || inner.cancelling.contains(asset_id) {
                return Ok(());
            }
            if let Some(existing) = inner.statuses.get(asset_id) {
                if existing.state == AssetState::Downloading {
                    return Ok(());
                }
                if existing.state == AssetState::Downloaded {
                    // Essentials are on disk; top-up only when an optional
                    // file is still missing (lets the user add mmproj to an
                    // already-installed model without losing it to Delete +
                    // redownload). True no-op when everything is in place.
                    let all_optional_present = asset
                        .optional_files
                        .iter()
                        .all(|opt| asset.target_dir.join(&opt.local_name).is_file());
                    if all_optional_present {
                        return Ok(());
                    }
                }
            }
            inner.active.insert(asset_id.to_string(), cancel.clone());
            let total = inner
                .statuses
                .get(asset_id)
                .map(|s| s.total)
                .unwrap_or(asset.estimated_bytes);
            let downloaded = inner
                .statuses
                .get(asset_id)
                .map(|s| s.downloaded)
                .unwrap_or(0);
            let optional_complete = asset
                .optional_files
                .iter()
                .all(|opt| asset.target_dir.join(&opt.local_name).is_file());
            inner.statuses.insert(
                asset_id.to_string(),
                AssetStatus {
                    entry_id: asset_id.to_string(),
                    state: AssetState::Downloading,
                    downloaded,
                    total,
                    optional_complete,
                    error: None,
                },
            );
        }

        // Worker owns the cancel flag + the cloned Asset. AppHandle
        // is Clone (Arc internally), so handing it off is free. The
        // spawn-cleanup branch erases the active-map row regardless
        // of whether the worker returned Ok or Err.
        let asset_id = asset.id.clone();
        let app_clone = app.clone();
        let asset_for_cleanup = asset.clone();
        tauri::async_runtime::spawn(async move {
            let result = worker::run(app_clone.clone(), asset, cancel).await;
            if let Err(error) = &result {
                tracing::error!(
                    error = ?error,
                    asset_id = %asset_id,
                    "download worker exited with error"
                );
            }
            let registry = app_clone.state::<DownloadsManager>();
            // Drop the `active` marker so a fresh `start()` for an
            // unrelated reason can rerun, but KEEP the `cancelling`
            // marker — that's the flag `start()` checks to refuse
            // re-spawning while we're still cleaning the disk. If we
            // cleared it before `delete_asset_files`, a racing new
            // `start()` could spawn a worker whose `.part` we'd then
            // wipe a few microseconds later.
            let was_cancelling = {
                let mut inner = registry.inner.lock().unwrap_or_else(|p| p.into_inner());
                inner.active.remove(&asset_id);
                inner.cancelling.contains(&asset_id)
            };
            if was_cancelling {
                delete_asset_files(&asset_for_cleanup);
                if let Ok(mut inner) = registry.inner.lock() {
                    inner.cancelling.remove(&asset_id);
                }
            }
        });
        Ok(())
    }

    /// Soft stop: flip the cancel flag. Worker observes on its next
    /// chunk boundary and emits a `Paused` event. The `.part` file is
    /// left in place so the next `start()` resumes from where we
    /// stopped.
    pub fn pause(&self, asset_id: &str) {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(flag) = inner.active.get(asset_id) {
            flag.store(true, Ordering::Release);
        }
    }

    /// Hard stop: snap the entry back to NotDownloaded, wipe any
    /// on-disk artefacts, and broadcast a `Cancelled` event so the
    /// panel updates synchronously.
    pub fn cancel_and_delete(&self, asset_id: &str) -> Result<()> {
        let asset = self
            .provider
            .assets()
            .into_iter()
            .find(|a| a.id == asset_id)
            .with_context(|| format!("unknown asset id: {asset_id}"))?;

        let was_active;
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            was_active = match inner.active.get(asset_id) {
                Some(flag) => {
                    flag.store(true, Ordering::Release);
                    inner.cancelling.insert(asset_id.to_string());
                    true
                }
                None => false,
            };
            // Even with no active worker, mark `cancelling` for the
            // window we hold the file open below — otherwise a
            // racing `start()` could spawn a worker whose `.part`
            // file we'd immediately wipe.
            if !was_active {
                inner.cancelling.insert(asset_id.to_string());
            }
            inner.statuses.insert(
                asset_id.to_string(),
                AssetStatus::not_downloaded(asset_id.to_string(), asset.estimated_bytes),
            );
            let event = AssetEvent {
                entry_id: asset_id.to_string(),
                kind: AssetEventKind::Cancelled {
                    total: asset.estimated_bytes,
                },
            };
            inner
                .subscribers
                .retain(|sub| sub.send(event.clone()).is_ok());
        }

        if !was_active {
            delete_asset_files(&asset);
            if let Ok(mut inner) = self.inner.lock() {
                inner.cancelling.remove(asset_id);
            }
        }
        Ok(())
    }

    // -- helpers used by `worker` ---------------------------------------

    /// Worker calls this on every state transition. We update the
    /// in-memory snapshot AND broadcast to subscribers in one pass.
    pub(super) fn emit(&self, event: AssetEvent) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.cancelling.contains(&event.entry_id) {
            return;
        }
        let entry = inner
            .statuses
            .entry(event.entry_id.clone())
            .or_insert_with(|| AssetStatus::not_downloaded(event.entry_id.clone(), 0));
        match &event.kind {
            AssetEventKind::Started { total } => {
                entry.state = AssetState::Downloading;
                entry.total = *total;
                entry.error = None;
            }
            AssetEventKind::Progress {
                downloaded, total, ..
            } => {
                entry.state = AssetState::Downloading;
                entry.downloaded = *downloaded;
                entry.total = *total;
            }
            AssetEventKind::Paused { downloaded, total } => {
                entry.state = AssetState::Paused;
                entry.downloaded = *downloaded;
                entry.total = *total;
            }
            AssetEventKind::Cancelled { total } => {
                entry.state = AssetState::NotDownloaded;
                entry.downloaded = 0;
                entry.total = *total;
                entry.error = None;
            }
            AssetEventKind::Completed {
                downloaded,
                optional_complete,
                ..
            } => {
                entry.state = AssetState::Downloaded;
                entry.downloaded = *downloaded;
                entry.total = *downloaded;
                entry.optional_complete = *optional_complete;
                entry.error = None;
            }
            AssetEventKind::Failed { error, .. } => {
                entry.state = AssetState::Failed;
                entry.error = Some(error.clone());
            }
        }
        inner
            .subscribers
            .retain(|sub| sub.send(event.clone()).is_ok());
    }

    /// Lazy reqwest client — caller-side clone is fine, the inner
    /// connection pool is shared.
    pub(super) fn http_client(&self) -> Result<reqwest::Client> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(client) = &inner.http {
            return Ok(client.clone());
        }
        let client = reqwest::Client::builder()
            // HF resolves to CloudFront / blob CDNs. 60 s connect is
            // generous for first DNS + TLS round trip on slow links.
            .connect_timeout(std::time::Duration::from_secs(60))
            // No global read timeout: large model downloads can run
            // for an hour+; reqwest's per-chunk timeout still applies.
            .user_agent(format!("helmor/{} downloads", env!("CARGO_PKG_VERSION")))
            .build()
            .context("build downloads HTTP client")?;
        inner.http = Some(client.clone());
        Ok(client)
    }
}

// ---------------------------------------------------------------------------
// File-system helpers (asset-aware).
// ---------------------------------------------------------------------------

/// Best-effort removal of every artefact an asset could have left on
/// disk — final files AND their `.part` counterparts. NotFound is
/// ignored. Sweeps both essential and optional files.
fn delete_asset_files(asset: &Asset) {
    let optional_locals = asset.optional_files.iter().map(|o| &o.local_name);
    for file in asset.files.iter().chain(optional_locals) {
        let final_path = asset.target_dir.join(file);
        let part_path = asset.target_dir.join(format!("{file}.part"));

        for candidate in [final_path, part_path] {
            match std::fs::remove_file(&candidate) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        path = %candidate.display(),
                        "failed to delete download artefact"
                    );
                }
            }
        }
    }
}

/// Disk scan: derive an `AssetStatus` purely from what's on disk. The
/// state machine looks at `files` only — `optional_files` contribute to
/// the on-disk footprint reported as `downloaded` but their absence
/// never demotes the asset out of `Downloaded`.
fn scan_asset_state(asset: &Asset) -> AssetStatus {
    let mut downloaded: u64 = 0;
    let mut all_complete = true;
    let mut any_present = false;
    let mut any_partial = false;
    for file in &asset.files {
        let final_path = asset.target_dir.join(file);
        let part_path = asset.target_dir.join(format!("{file}.part"));
        if let Ok(meta) = std::fs::metadata(&final_path) {
            downloaded = downloaded.saturating_add(meta.len());
            any_present = true;
            continue;
        }
        all_complete = false;
        if let Ok(meta) = std::fs::metadata(&part_path) {
            downloaded = downloaded.saturating_add(meta.len());
            any_partial = true;
            any_present = true;
        }
    }
    let mut optional_complete = true;
    for opt in &asset.optional_files {
        let final_path = asset.target_dir.join(&opt.local_name);
        let part_path = asset.target_dir.join(format!("{}.part", opt.local_name));
        if let Ok(meta) = std::fs::metadata(&final_path) {
            downloaded = downloaded.saturating_add(meta.len());
        } else if let Ok(meta) = std::fs::metadata(&part_path) {
            downloaded = downloaded.saturating_add(meta.len());
            optional_complete = false;
        } else {
            optional_complete = false;
        }
    }
    let state = if all_complete {
        AssetState::Downloaded
    } else if any_partial || any_present {
        AssetState::Paused
    } else {
        AssetState::NotDownloaded
    };
    AssetStatus {
        entry_id: asset.id.clone(),
        state,
        downloaded,
        total: asset.estimated_bytes.max(downloaded),
        optional_complete,
        error: None,
    }
}

// Anchored at this file because `delete_asset_files` lives here too.
#[cfg(test)]
mod tests {
    use super::super::types::ArchiveKind;
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    fn fake_asset(target_dir: &Path, files: &[&str]) -> Asset {
        Asset {
            id: "fake".into(),
            target_dir: target_dir.to_path_buf(),
            files: files.iter().map(|f| (*f).to_string()).collect(),
            optional_files: Vec::new(),
            source: super::super::types::AssetSource::HuggingFace {
                repo: "fake/repo".into(),
            },
            archive: ArchiveKind::None,
            is_directory: false,
            estimated_bytes: 1_000,
        }
    }

    #[test]
    fn scan_marks_manually_placed_single_file_as_downloaded() {
        let dir = tempdir().expect("tempdir");
        let asset = fake_asset(dir.path(), &["model.gguf"]);
        fs::write(dir.path().join("model.gguf"), b"hello world").expect("write final");

        let status = scan_asset_state(&asset);
        assert!(
            matches!(status.state, AssetState::Downloaded),
            "expected Downloaded, got {:?}",
            status.state
        );
        assert_eq!(status.downloaded, 11);
    }

    #[test]
    fn scan_marks_part_file_as_paused() {
        let dir = tempdir().expect("tempdir");
        let asset = fake_asset(dir.path(), &["model.gguf"]);
        fs::write(dir.path().join("model.gguf.part"), b"halfway").expect("write part");

        let status = scan_asset_state(&asset);
        assert!(matches!(status.state, AssetState::Paused));
        assert_eq!(status.downloaded, 7);
    }

    #[test]
    fn scan_marks_partial_multi_part_set_as_paused() {
        let dir = tempdir().expect("tempdir");
        let asset = fake_asset(dir.path(), &["part1.gguf", "part2.gguf", "part3.gguf"]);
        fs::write(dir.path().join("part1.gguf"), b"first").expect("write part1");
        fs::write(dir.path().join("part2.gguf"), b"second").expect("write part2");

        let status = scan_asset_state(&asset);
        assert!(
            matches!(status.state, AssetState::Paused),
            "expected Paused for partial multi-part set, got {:?}",
            status.state
        );
        assert_eq!(status.downloaded, 11);
    }

    #[test]
    fn scan_returns_not_downloaded_for_empty_dir() {
        let dir = tempdir().expect("tempdir");
        let asset = fake_asset(dir.path(), &["model.gguf"]);
        let status = scan_asset_state(&asset);
        assert!(matches!(status.state, AssetState::NotDownloaded));
        assert_eq!(status.downloaded, 0);
    }

    #[test]
    fn essential_only_is_downloaded_when_optional_file_missing() {
        // Regression: previously, adding mmproj to `files` flipped the
        // scan from Downloaded → Paused for existing main-only installs,
        // making every old model show up in the Downloads section.
        let dir = tempdir().expect("tempdir");
        let mut asset = fake_asset(dir.path(), &["model.gguf"]);
        asset.optional_files = vec![super::super::types::OptionalFile {
            remote_name: "mmproj.gguf".into(),
            local_name: "mmproj.gguf".into(),
        }];
        fs::write(dir.path().join("model.gguf"), b"weights").expect("write main");

        let status = scan_asset_state(&asset);
        assert!(
            matches!(status.state, AssetState::Downloaded),
            "main-only install must stay Downloaded, got {:?}",
            status.state
        );
        assert_eq!(status.downloaded, 7);
    }

    #[test]
    fn optional_file_bytes_count_toward_disk_footprint() {
        let dir = tempdir().expect("tempdir");
        let mut asset = fake_asset(dir.path(), &["model.gguf"]);
        asset.optional_files = vec![super::super::types::OptionalFile {
            remote_name: "mmproj.gguf".into(),
            local_name: "mmproj.gguf".into(),
        }];
        fs::write(dir.path().join("model.gguf"), b"weights").expect("write main");
        fs::write(dir.path().join("mmproj.gguf"), b"vision").expect("write mmproj");

        let status = scan_asset_state(&asset);
        assert!(matches!(status.state, AssetState::Downloaded));
        assert_eq!(status.downloaded, 13);
    }
}
