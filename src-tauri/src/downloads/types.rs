//! Wire types for the generic downloads manager.

use std::path::PathBuf;

use serde::Serialize;

/// One downloadable artefact. A caller (e.g. `local_llm`) translates
/// its domain catalog entries into a Vec of these and registers an
/// `AssetProvider` with `DownloadsManager`.
#[derive(Debug, Clone)]
pub struct Asset {
    /// Stable id — the manager keys state, events, and cancel flags
    /// off this. Two `Asset`s with the same id are the same logical
    /// download (newer registration replaces older).
    pub id: String,
    /// On-disk destination directory. The manager creates it if
    /// missing. Multi-file assets (HF GGUF shards) live here as
    /// peers; tar.gz assets extract their contents here.
    pub target_dir: PathBuf,
    /// File names relative to `target_dir`. For HF entries: every
    /// shard, downloaded sequentially. For direct-URL entries:
    /// `files[0]` is the on-disk name (or the extracted top-level
    /// directory name for `ArchiveKind::TarGz`).
    pub files: Vec<String>,
    /// Where bytes come from.
    pub source: AssetSource,
    /// Post-download decoration (extract / verify-only / …).
    pub archive: ArchiveKind,
    /// On disk, is `files[0]` a directory (true for tar.gz-extracted
    /// models) or a regular file?
    pub is_directory: bool,
    /// Catalog estimate of total bytes. Used as a UI fallback before
    /// the first HTTP `Content-Length` arrives, and as the canonical
    /// "size" reported when the artefact is already on disk.
    pub estimated_bytes: u64,
}

/// Where the manager fetches bytes from. Only HuggingFace today (LLM
/// GGUFs); the enum stays open so future direct-URL sources can plug
/// in without churning the whole pipeline.
#[derive(Debug, Clone)]
pub enum AssetSource {
    /// Resolved against `https://huggingface.co/{repo}/resolve/main/<file>`.
    /// Manifest fetched best-effort for per-file size + SHA-256;
    /// missing manifest falls back to HTTP `Content-Length` + no
    /// integrity verification.
    HuggingFace { repo: String },
}

/// What we do with the downloaded bytes once they hit `.part`. Only
/// the rename path is exercised today — the enum is kept so the
/// downloader stays generic if/when new archive formats need support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ArchiveKind {
    /// Rename `.part` to its final name and call it done.
    #[default]
    None,
}

/// State machine for one asset. Names match the four "cards on the
/// wall" the UI shows + an explicit `Failed` so panels can surface
/// retry affordances instead of silently bouncing back to NotDownloaded.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetState {
    NotDownloaded,
    Downloading,
    Paused,
    Downloaded,
    Failed,
}

/// Snapshot of one asset's state, returned by `snapshot()` / `subscribe()`.
/// Field name kept as `entry_id` (not `asset_id`) for wire compat with
/// the `local_llm:*` IPC contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStatus {
    pub entry_id: String,
    pub state: AssetState,
    /// Bytes already on disk (sum of completed parts + current part).
    pub downloaded: u64,
    /// Total bytes expected. For not-yet-started downloads this is
    /// the asset estimate; once the first part hits the network it's
    /// replaced with the real `Content-Length`.
    pub total: u64,
    /// Last error message — only meaningful when `state == Failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AssetStatus {
    pub fn not_downloaded(entry_id: impl Into<String>, total: u64) -> Self {
        Self {
            entry_id: entry_id.into(),
            state: AssetState::NotDownloaded,
            downloaded: 0,
            total,
            error: None,
        }
    }
}

/// One streamed event from the download worker. Always carries
/// `entry_id` so the frontend can route it to the right card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEvent {
    pub entry_id: String,
    #[serde(flatten)]
    pub kind: AssetEventKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AssetEventKind {
    Started {
        total: u64,
    },
    Progress {
        downloaded: u64,
        total: u64,
        /// Smoothed instantaneous throughput (rolling over the last
        /// emit window, ~250 ms).
        bytes_per_sec: f64,
    },
    Paused {
        downloaded: u64,
        total: u64,
    },
    /// User-initiated full reset: stop the worker, wipe artefacts
    /// from disk, snap status back to NotDownloaded. Distinct from
    /// `Paused` so subscribers don't accidentally show a progress
    /// bar at the partial state we just deleted.
    Cancelled {
        total: u64,
    },
    Completed {
        downloaded: u64,
        /// Absolute path of the artefact's "primary" file (multi-part
        /// GGUFs report part 1; tar.gz reports the extracted dir).
        /// Callers use this to wire the artefact into their runtime.
        path: String,
        sha256_verified: bool,
    },
    Failed {
        error: String,
        /// Set when the failure looks recoverable (network drop, 5xx,
        /// rate limit) so the panel can surface a Retry affordance.
        retryable: bool,
    },
}
