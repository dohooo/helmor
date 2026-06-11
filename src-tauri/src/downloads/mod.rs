//! General-purpose download / cache manager.
//!
//! Zero business concepts live in this module — no notion of "LLM
//! catalog", "STT engine", or "Voice Pilot". Callers describe what
//! they want as `Asset`s, register an `AssetProvider`, and the
//! manager handles:
//!
//!   * Snapshot-from-disk (NotDownloaded / Downloading / Paused /
//!     Downloaded / Failed) with on-demand rescan so manually placed
//!     files are picked up.
//!   * Resumable HTTP streaming with `Range:` headers + per-chunk
//!     SHA-256 hashing.
//!   * Optional tar.gz extraction after successful download.
//!   * Pause vs. cancel (cancel wipes `.part`; pause keeps it).
//!   * Subscriber channels: every state transition fans out to every
//!     `Channel<AssetEvent>` registered through `subscribe()`.
//!
//! Designed to grow into the single place every long-running download
//! in Helmor flows through (local AI weights, STT models, in-app
//! updates that we control directly, future plugin packs, etc).

mod hf;
mod registry;
mod types;
mod worker;

pub use registry::{AssetProvider, DownloadsManager};
pub use types::{
    ArchiveKind, Asset, AssetEvent, AssetEventKind, AssetSource, AssetState, AssetStatus,
    OptionalFile,
};
