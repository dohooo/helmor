//! The async body that actually pulls bytes from a remote source.
//!
//! One worker per `Asset.id`. Multi-part HF assets are downloaded
//! sequentially (HF CDN doesn't reward parallel chunks per host, and
//! sequential keeps the progress bar honest).
//!
//! Lifecycle:
//!   1. Compute the total expected bytes (HF manifest or asset estimate).
//!   2. Emit `Started`.
//!   3. For each file: stream `Range:`-resumed bytes to `.part`,
//!      hash them on the fly, throttled-emit `Progress`.
//!   4. On EOF: verify SHA-256 (when manifest provided one), rename
//!      `.part` to its final name.
//!   5. Emit `Completed` once everything's on disk.
//!
//! Cancel observed at every chunk boundary — for a 5 GB download
//! over a typical residential connection that's ~250 ms of polling
//! granularity, plenty fast for "Pause" to feel instant.

use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::hf::HfManifest;
use super::registry::DownloadsManager;
use super::types::{Asset, AssetEvent, AssetEventKind, AssetSource};

/// Throttle progress events to ~4/sec. UI doesn't need finer
/// granularity, and a flood of Channel sends starves the Tauri ipc
/// thread on slow machines.
const EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Chunk-level fsync cadence. Reading from a network stream is
/// dominated by socket latency; flushing every ~8 MB keeps disk-flush
/// amortised without making a power-cut resume re-download more than
/// a few seconds.
const FSYNC_INTERVAL: u64 = 8 * 1024 * 1024;

/// Per-chunk read timeout. The HTTP client only has a connect timeout
/// — without an explicit chunk-level deadline a TCP connection that
/// silently stops producing data (CDN edge wedge, NAT timeout, ISP
/// rebalance) would wedge the worker forever and Pause/Cancel only
/// fires on the *next* chunk boundary. 90 s is well above normal
/// inter-chunk gaps for HF-served LFS objects (~ms range) while still
/// surfacing a stuck stream within a useful window.
const CHUNK_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

pub async fn run(app: tauri::AppHandle, asset: Asset, cancel: Arc<AtomicBool>) -> Result<()> {
    tokio::fs::create_dir_all(&asset.target_dir)
        .await
        .with_context(|| format!("mkdir {}", asset.target_dir.display()))?;

    let registry = app.state::<DownloadsManager>();
    let client = registry.http_client()?;

    match asset.source.clone() {
        AssetSource::HuggingFace { repo } => run_hf(asset, &repo, cancel, &client, &registry).await,
    }
}

async fn run_hf(
    asset: Asset,
    repo: &str,
    cancel: Arc<AtomicBool>,
    client: &reqwest::Client,
    registry: &DownloadsManager,
) -> Result<()> {
    // Best-effort HF manifest. If this fails we still download (skip
    // SHA-256 verification + trust HTTP Content-Length).
    let manifest = match HfManifest::fetch(client, repo).await {
        Ok(m) => Some(m),
        Err(error) => {
            tracing::warn!(
                error = ?error,
                repo,
                "HF manifest fetch failed, continuing without integrity check"
            );
            None
        }
    };

    // Top-up mode: every essential already on disk AND at least one
    // optional missing. The UI's progress bar gets scoped to just the
    // optional bytes so the user doesn't see a misleading "20.5/22.0 GB
    // · 93%" the instant they click "Add vision" — which previously
    // read like the model was being re-downloaded.
    let mut all_essentials_present = true;
    for file in &asset.files {
        if tokio::fs::metadata(asset.target_dir.join(file))
            .await
            .is_err()
        {
            all_essentials_present = false;
            break;
        }
    }
    let mut any_optional_missing = false;
    for opt in &asset.optional_files {
        if tokio::fs::metadata(asset.target_dir.join(&opt.local_name))
            .await
            .is_err()
        {
            any_optional_missing = true;
            break;
        }
    }
    let top_up_mode = all_essentials_present && any_optional_missing;

    let total_expected = if top_up_mode {
        compute_total_optional_hf(&asset, manifest.as_ref())
    } else {
        compute_total_hf(&asset, manifest.as_ref())
    };
    registry.emit(AssetEvent {
        entry_id: asset.id.clone(),
        kind: AssetEventKind::Started {
            total: total_expected,
        },
    });

    let mut accumulated: u64 = 0;
    let mut last_emit = Instant::now();
    let mut last_bytes_marker = 0u64;
    let mut any_sha_verified = false;

    // Essential files: any failure aborts the whole asset. Skipped in
    // top-up mode — we already verified every essential is on disk so
    // the loop body would only `continue` anyway.
    if !top_up_mode {
        for file in &asset.files {
            let final_path = asset.target_dir.join(file);
            let part_path = asset.target_dir.join(format!("{file}.part"));

            if let Ok(meta) = tokio::fs::metadata(&final_path).await {
                accumulated = accumulated.saturating_add(meta.len());
                continue;
            }

            let expected_size = manifest
                .as_ref()
                .and_then(|m| m.per_file.get(file))
                .and_then(|info| info.size)
                .unwrap_or(0);
            let expected_sha256 = manifest
                .as_ref()
                .and_then(|m| m.per_file.get(file))
                .and_then(|info| info.sha256.clone());

            let url = format!("https://huggingface.co/{repo}/resolve/main/{file}");
            let outcome = stream_to_part(
                client,
                &asset,
                &url,
                &part_path,
                expected_size,
                expected_sha256.as_deref(),
                &cancel,
                registry,
                &mut accumulated,
                total_expected,
                &mut last_emit,
                &mut last_bytes_marker,
            )
            .await;

            match outcome {
                Ok(FileOutcome::Completed { sha256_ok }) => {
                    tokio::fs::rename(&part_path, &final_path)
                        .await
                        .with_context(|| {
                            format!("rename {} -> {}", part_path.display(), final_path.display())
                        })?;
                    if sha256_ok {
                        any_sha_verified = true;
                    }
                }
                Ok(FileOutcome::Paused { downloaded }) => {
                    registry.emit(AssetEvent {
                        entry_id: asset.id.clone(),
                        kind: AssetEventKind::Paused {
                            downloaded,
                            total: total_expected,
                        },
                    });
                    return Ok(());
                }
                Err(error) => {
                    let retryable = is_retryable(&error);
                    registry.emit(AssetEvent {
                        entry_id: asset.id.clone(),
                        kind: AssetEventKind::Failed {
                            error: format!("{error:#}"),
                            retryable,
                        },
                    });
                    return Err(error);
                }
            }
        }
    } // end !top_up_mode

    // Optional files: best-effort. A missing/failed projector still
    // leaves the main weights usable as text-only; we log and continue.
    // `remote_name` keys the HF fetch + manifest; `local_name` is the on-disk
    // filename (kept distinct so two assets with the same projector basename
    // in different repos can coexist in a flat target dir).
    for opt in &asset.optional_files {
        let final_path = asset.target_dir.join(&opt.local_name);
        let part_path = asset.target_dir.join(format!("{}.part", opt.local_name));

        if tokio::fs::metadata(&final_path).await.is_ok() {
            continue;
        }
        if cancel.load(Ordering::Acquire) {
            // User cancelled mid-optional — fall through to the
            // Paused-emit path below.
            registry.emit(AssetEvent {
                entry_id: asset.id.clone(),
                kind: AssetEventKind::Paused {
                    downloaded: accumulated,
                    total: total_expected,
                },
            });
            return Ok(());
        }

        let expected_size = manifest
            .as_ref()
            .and_then(|m| m.per_file.get(&opt.remote_name))
            .and_then(|info| info.size)
            .unwrap_or(0);
        let expected_sha256 = manifest
            .as_ref()
            .and_then(|m| m.per_file.get(&opt.remote_name))
            .and_then(|info| info.sha256.clone());

        let url = format!(
            "https://huggingface.co/{repo}/resolve/main/{}",
            opt.remote_name
        );
        match stream_to_part(
            client,
            &asset,
            &url,
            &part_path,
            expected_size,
            expected_sha256.as_deref(),
            &cancel,
            registry,
            &mut accumulated,
            total_expected,
            &mut last_emit,
            &mut last_bytes_marker,
        )
        .await
        {
            Ok(FileOutcome::Completed { sha256_ok }) => {
                if let Err(error) = tokio::fs::rename(&part_path, &final_path).await {
                    tracing::warn!(
                        error = %error,
                        file = %opt.local_name,
                        "optional file rename failed; continuing without it"
                    );
                }
                if sha256_ok {
                    any_sha_verified = true;
                }
            }
            Ok(FileOutcome::Paused { downloaded }) => {
                registry.emit(AssetEvent {
                    entry_id: asset.id.clone(),
                    kind: AssetEventKind::Paused {
                        downloaded,
                        total: total_expected,
                    },
                });
                return Ok(());
            }
            Err(error) => {
                tracing::warn!(
                    error = %format!("{error:#}"),
                    file = %opt.local_name,
                    "optional file download failed; asset will be usable without it"
                );
                let _ = tokio::fs::remove_file(&part_path).await;
            }
        }
    }

    let primary = asset.target_dir.join(&asset.files[0]);
    let optional_complete = asset
        .optional_files
        .iter()
        .all(|opt| asset.target_dir.join(&opt.local_name).is_file());
    registry.emit(AssetEvent {
        entry_id: asset.id.clone(),
        kind: AssetEventKind::Completed {
            downloaded: accumulated,
            path: primary.display().to_string(),
            sha256_verified: any_sha_verified,
            optional_complete,
        },
    });
    Ok(())
}

enum FileOutcome {
    Completed { sha256_ok: bool },
    Paused { downloaded: u64 },
}

#[allow(clippy::too_many_arguments)]
async fn stream_to_part(
    client: &reqwest::Client,
    asset: &Asset,
    url: &str,
    part_path: &PathBuf,
    expected_size: u64,
    expected_sha256: Option<&str>,
    cancel: &AtomicBool,
    registry: &DownloadsManager,
    accumulated: &mut u64,
    total_expected: u64,
    last_emit: &mut Instant,
    last_bytes_marker: &mut u64,
) -> Result<FileOutcome> {
    let mut resume_from = tokio::fs::metadata(part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if expected_size > 0 && resume_from >= expected_size {
        tokio::fs::remove_file(part_path).await.ok();
        resume_from = 0;
    }

    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header("Range", format!("bytes={resume_from}-"));
    }
    let response = req.send().await.with_context(|| format!("GET {url}"))?;
    let status = response.status();
    if !status.is_success() && status.as_u16() != 206 {
        anyhow::bail!("HTTP {status} from {url}");
    }
    let server_total = response
        .content_length()
        .map(|len| resume_from + len)
        .unwrap_or(expected_size.max(resume_from));

    let mut handle = if status == reqwest::StatusCode::OK && resume_from > 0 {
        resume_from = 0;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(part_path)
            .await
            .with_context(|| format!("open {} (truncate)", part_path.display()))?
    } else {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(part_path)
            .await
            .with_context(|| format!("open {}", part_path.display()))?
    };
    handle
        .seek(SeekFrom::Start(resume_from))
        .await
        .with_context(|| format!("seek to {} in {}", resume_from, part_path.display()))?;

    let mut hasher = Sha256::new();
    if resume_from > 0 {
        prime_hasher_from_file(part_path, resume_from, &mut hasher).await?;
    }

    let mut current_part_bytes = resume_from;
    let mut bytes_since_fsync: u64 = 0;
    let mut response = response;

    loop {
        if cancel.load(Ordering::Acquire) {
            handle.flush().await.ok();
            return Ok(FileOutcome::Paused {
                downloaded: *accumulated + current_part_bytes,
            });
        }
        // Bound each chunk read so a silently-stalled connection
        // surfaces as a retryable failure instead of wedging Pause /
        // Cancel until the OS gives up the socket.
        let chunk = match tokio::time::timeout(CHUNK_READ_TIMEOUT, response.chunk()).await {
            Ok(Ok(chunk)) => chunk,
            Ok(Err(error)) => {
                return Err(anyhow::Error::from(error))
                    .with_context(|| format!("chunk from {url} after {current_part_bytes} bytes"));
            }
            Err(_) => {
                anyhow::bail!(
                    "chunk from {url} timed out after {current_part_bytes} bytes \
                     (no data for {}s)",
                    CHUNK_READ_TIMEOUT.as_secs(),
                );
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        handle
            .write_all(&chunk)
            .await
            .with_context(|| format!("write {} bytes to {}", chunk.len(), part_path.display()))?;
        hasher.update(&chunk);
        let n = chunk.len() as u64;
        current_part_bytes = current_part_bytes.saturating_add(n);
        bytes_since_fsync = bytes_since_fsync.saturating_add(n);
        if bytes_since_fsync >= FSYNC_INTERVAL {
            handle.flush().await.ok();
            bytes_since_fsync = 0;
        }

        let overall = *accumulated + current_part_bytes;
        if last_emit.elapsed() >= EMIT_INTERVAL {
            let elapsed = last_emit.elapsed().as_secs_f64().max(1e-6);
            let bps = (overall.saturating_sub(*last_bytes_marker) as f64) / elapsed;
            registry.emit(AssetEvent {
                entry_id: asset.id.clone(),
                kind: AssetEventKind::Progress {
                    downloaded: overall,
                    total: total_expected
                        .max(overall + server_total.saturating_sub(current_part_bytes)),
                    bytes_per_sec: bps,
                },
            });
            *last_emit = Instant::now();
            *last_bytes_marker = overall;
        }
    }

    handle.flush().await.ok();
    handle.sync_all().await.ok();
    drop(handle);

    let sha256_ok = match expected_sha256 {
        Some(expected) => {
            let computed = hex::encode(hasher.finalize());
            if !computed.eq_ignore_ascii_case(expected) {
                anyhow::bail!(
                    "SHA-256 mismatch for {}: expected {expected}, got {computed}",
                    asset.id,
                );
            }
            true
        }
        None => false,
    };

    *accumulated = accumulated.saturating_add(current_part_bytes);
    Ok(FileOutcome::Completed { sha256_ok })
}

async fn prime_hasher_from_file(path: &PathBuf, bytes: u64, hasher: &mut Sha256) -> Result<()> {
    let mut file = File::open(path)
        .await
        .with_context(|| format!("reopen {} for re-hash", path.display()))?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut remaining = bytes;
    while remaining > 0 {
        let want = std::cmp::min(buf.len() as u64, remaining) as usize;
        let read = file
            .read(&mut buf[..want])
            .await
            .with_context(|| format!("read {} for re-hash", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        remaining = remaining.saturating_sub(read as u64);
    }
    Ok(())
}

fn compute_total_hf(asset: &Asset, manifest: Option<&HfManifest>) -> u64 {
    if let Some(manifest) = manifest {
        let mut sum: u64 = 0;
        let mut all_known = true;
        let optional_remotes = asset.optional_files.iter().map(|o| &o.remote_name);
        for file in asset.files.iter().chain(optional_remotes) {
            match manifest.per_file.get(file).and_then(|info| info.size) {
                Some(size) => sum = sum.saturating_add(size),
                None => {
                    all_known = false;
                    break;
                }
            }
        }
        if all_known {
            return sum;
        }
    }
    asset.estimated_bytes
}

/// Sum of `optional_files` sizes only — for top-up runs where the
/// essentials are already on disk and we want the progress bar scoped
/// to just the optional portion. Falls back to 0 if the manifest is
/// missing (UI will switch to indeterminate spinner, which is honest).
fn compute_total_optional_hf(asset: &Asset, manifest: Option<&HfManifest>) -> u64 {
    let Some(manifest) = manifest else {
        return 0;
    };
    let mut sum: u64 = 0;
    for opt in &asset.optional_files {
        match manifest.per_file.get(&opt.remote_name).and_then(|i| i.size) {
            Some(size) => sum = sum.saturating_add(size),
            None => return 0,
        }
    }
    sum
}

fn is_retryable(error: &anyhow::Error) -> bool {
    let msg = format!("{error:#}").to_ascii_lowercase();
    msg.contains("timed out")
        || msg.contains("timeout")
        || msg.contains("connection reset")
        || msg.contains("connection refused")
        || msg.contains("temporarily")
        || msg.contains("eof")
        || msg.contains("503")
        || msg.contains("504")
        || msg.contains("502")
        || msg.contains("429")
}

// hex encoding without pulling a crate
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let mut out = String::with_capacity(bytes.as_ref().len() * 2);
        for byte in bytes.as_ref() {
            out.push(nibble(byte >> 4));
            out.push(nibble(byte & 0x0F));
        }
        out
    }
    fn nibble(n: u8) -> char {
        match n {
            0..=9 => (b'0' + n) as char,
            10..=15 => (b'a' + (n - 10)) as char,
            _ => '?',
        }
    }
}
