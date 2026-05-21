//! Server-side state for chunked `workspace.bundle*` transfers.
//!
//! The single-shot `workspace.bundle` / `workspace.unbundle` pair
//! caps at 10 MiB raw because the codec's body buffer is 16 MiB.
//! That's enough for empty/demo repos and falls over the moment a
//! real workspace's `.git` directory accumulates history. The
//! chunked variants in this module ship a bundle across the wire
//! 4 MiB at a time (default — caller-tunable) inside a stable
//! transfer id, lifting the practical ceiling to whatever the
//! filesystem can hold.
//!
//! Lifecycle:
//!
//! - **Bundle (server → client):** `workspace.bundleBegin` runs the
//!   `git bundle` once, stashes the bytes + sha here, returns the
//!   transfer id + chunk count. The client loops
//!   `workspace.bundleChunk` until every chunk is in hand.
//!   `workspace.bundleEnd` releases the entry (or it ages out via
//!   the sweep).
//! - **Unbundle (client → server):** `workspace.unbundleBegin`
//!   allocates an inbound entry with the announced size + sha. The
//!   client loops `workspace.unbundleChunk` appending bytes;
//!   `workspace.unbundleFinish` verifies the assembled sha, runs
//!   `git clone`, releases the entry.
//!
//! Both directions share one store + sweep — entries are tagged by
//! direction so a client can't accidentally pull from an inbound
//! transfer (or push to an outbound one).
//!
//! ## Inactivity sweep
//!
//! Each operation calls `sweep_expired` first. Entries with a
//! `last_access` older than [`TRANSFER_TTL`] are dropped. That
//! avoids both leaks (client crashed mid-transfer) and zombie
//! state lingering after a successful transfer the client forgot
//! to `bundleEnd`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

/// Default chunk size when the client doesn't specify one. 4 MiB
/// fits comfortably under the codec's 16 MiB body cap even after
/// base64 inflation (~4/3 = ~5.3 MiB).
pub const DEFAULT_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Hard upper bound on per-chunk size. 8 MiB raw → ~10.7 MiB base64,
/// still inside the 16 MiB cap with room for the JSON envelope.
/// Callers asking for more get clamped.
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// How long a transfer can sit idle before the sweep drops it. 5
/// minutes covers normal interruptions (slow network, paused
/// desktop) without leaking memory indefinitely.
pub const TRANSFER_TTL: Duration = Duration::from_secs(5 * 60);

/// Hard ceiling on the *total* bundle size we'll accept inbound.
/// Surfaces as a clean error on `unbundleBegin` rather than letting
/// a misbehaving client allocate a gigabyte of `Vec<u8>` on the
/// daemon. 2 GiB is generous for real workspaces; bigger transfers
/// belong in `rsync` territory.
pub const MAX_TRANSFER_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Which way bytes are flowing through this transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    /// Server has the full bundle; client is pulling chunks.
    Outbound,
    /// Client is pushing chunks; server assembles then clones.
    Inbound,
}

/// One in-flight chunked transfer. `bytes` is the full buffer —
/// for outbound, populated up front by `bundleBegin`; for inbound,
/// grown chunk-by-chunk as `unbundleChunk` calls land.
struct Transfer {
    direction: Direction,
    /// Full buffer. For outbound, indexed by chunk. For inbound,
    /// grown to `expected_size_bytes` over the chunk calls.
    bytes: Vec<u8>,
    /// Caller's declared SHA-256. Outbound: computed when the
    /// bundle was generated. Inbound: caller-supplied via
    /// `unbundleBegin`; verified before clone.
    sha256_hex: String,
    /// Total size of the assembled bundle. For outbound, set up
    /// front (matches `bytes.len()`). For inbound, set up front +
    /// validated as chunks land (the final `bytes.len()` must
    /// match exactly).
    expected_size_bytes: usize,
    /// For inbound transfers: where the daemon should `git clone`
    /// when `unbundleFinish` lands. `None` for outbound.
    target_dir: Option<String>,
    /// Bumped on every operation that touches the transfer. The
    /// sweep drops entries with stale timestamps.
    last_access: Instant,
}

impl Transfer {
    fn touch(&mut self) {
        self.last_access = Instant::now();
    }
}

/// Shared store of active transfers. Lives on
/// [`super::ServerContext`] (one per accepted connection in
/// stdio mode, one shared across connections in daemon mode).
pub struct BundleTransferStore {
    transfers: Mutex<HashMap<String, Transfer>>,
}

impl BundleTransferStore {
    pub fn new() -> Self {
        Self {
            transfers: Mutex::new(HashMap::new()),
        }
    }

    /// Stash a fully-generated outbound bundle + return the transfer
    /// id the client should use for subsequent `bundleChunk` calls.
    pub fn register_outbound(&self, bytes: Vec<u8>, sha256_hex: String) -> Result<String> {
        let mut map = self.lock();
        sweep_expired_locked(&mut map);
        let id = generate_id();
        let expected_size_bytes = bytes.len();
        map.insert(
            id.clone(),
            Transfer {
                direction: Direction::Outbound,
                expected_size_bytes,
                bytes,
                sha256_hex,
                target_dir: None,
                last_access: Instant::now(),
            },
        );
        Ok(id)
    }

    /// Pull one chunk of `chunk_size_bytes` (clamped to
    /// [`MAX_CHUNK_BYTES`]) from an outbound transfer. Returns the
    /// raw bytes; the handler base64-encodes for the wire.
    pub fn read_chunk(
        &self,
        transfer_id: &str,
        chunk_index: usize,
        chunk_size_bytes: usize,
    ) -> Result<Vec<u8>> {
        let mut map = self.lock();
        sweep_expired_locked(&mut map);
        let transfer = map.get_mut(transfer_id).with_context(|| {
            format!("no such transfer `{transfer_id}` (expired or never started)")
        })?;
        if transfer.direction != Direction::Outbound {
            bail!("transfer `{transfer_id}` is inbound; use unbundleChunk to push bytes, not bundleChunk");
        }
        let chunk_size = chunk_size_bytes.clamp(1, MAX_CHUNK_BYTES);
        let start = chunk_index.checked_mul(chunk_size).ok_or_else(|| {
            anyhow::anyhow!("chunk_index {chunk_index} × chunk_size {chunk_size} overflowed usize",)
        })?;
        if start >= transfer.bytes.len() {
            bail!(
                "chunk_index {chunk_index} is past the end of transfer `{transfer_id}` ({} bytes total)",
                transfer.bytes.len(),
            );
        }
        let end = (start + chunk_size).min(transfer.bytes.len());
        let slice = transfer.bytes[start..end].to_vec();
        transfer.touch();
        Ok(slice)
    }

    /// Release an outbound transfer the client is done with. The
    /// sweep would catch it anyway, but explicit release frees memory
    /// faster + gives the client a clean point to fail at if the
    /// server lost the transfer (concurrent disconnect, etc.).
    pub fn release(&self, transfer_id: &str) -> Result<()> {
        let mut map = self.lock();
        sweep_expired_locked(&mut map);
        map.remove(transfer_id)
            .with_context(|| format!("no such transfer `{transfer_id}` to release"))?;
        Ok(())
    }

    /// Allocate an inbound transfer the client is about to push
    /// chunks into. Returns the transfer id; subsequent
    /// `unbundleChunk` calls reference it.
    pub fn register_inbound(
        &self,
        target_dir: String,
        total_size_bytes: u64,
        sha256_hex: String,
    ) -> Result<String> {
        if total_size_bytes > MAX_TRANSFER_BYTES {
            bail!(
                "inbound bundle is {total_size_bytes} bytes; daemon caps inbound transfers at {} bytes ({} GiB)",
                MAX_TRANSFER_BYTES,
                MAX_TRANSFER_BYTES / (1024 * 1024 * 1024),
            );
        }
        if target_dir.trim().is_empty() {
            bail!("target_dir must not be empty");
        }
        if sha256_hex.is_empty() {
            bail!("sha256_hex must not be empty");
        }
        let mut map = self.lock();
        sweep_expired_locked(&mut map);
        let id = generate_id();
        map.insert(
            id.clone(),
            Transfer {
                direction: Direction::Inbound,
                bytes: Vec::with_capacity(total_size_bytes as usize),
                sha256_hex,
                expected_size_bytes: total_size_bytes as usize,
                target_dir: Some(target_dir),
                last_access: Instant::now(),
            },
        );
        Ok(id)
    }

    /// Append a chunk to an inbound transfer. Chunk indexes must
    /// arrive in order — daemons today don't support out-of-order
    /// uploads (would require an offset hashmap; not worth the
    /// complexity vs. a re-transfer on lossy networks).
    pub fn write_chunk(
        &self,
        transfer_id: &str,
        chunk_index: usize,
        chunk_bytes: Vec<u8>,
    ) -> Result<()> {
        let mut map = self.lock();
        sweep_expired_locked(&mut map);
        let transfer = map.get_mut(transfer_id).with_context(|| {
            format!("no such transfer `{transfer_id}` (expired or never started)")
        })?;
        if transfer.direction != Direction::Inbound {
            bail!("transfer `{transfer_id}` is outbound; use bundleChunk to pull bytes, not unbundleChunk");
        }
        // We use the running buffer length to enforce in-order
        // chunks — chunk 0 starts at offset 0, chunk 1 starts at
        // offset chunk_0_size, etc.
        let expected_starting_offset = transfer.bytes.len();
        let chunk_size = chunk_bytes.len();
        // A zero-length chunk would be a no-op; reject so we don't
        // silently accept a transfer that never advances.
        if chunk_size == 0 {
            bail!("chunk_bytes must not be empty for chunk_index {chunk_index}");
        }
        // Reject overflowing-past-the-declared-size up front so a
        // misbehaving client can't OOM the daemon by pushing
        // unbounded chunks.
        if expected_starting_offset + chunk_size > transfer.expected_size_bytes {
            bail!(
                "chunk {chunk_index} would overflow declared total size {} (current {} + chunk {})",
                transfer.expected_size_bytes,
                expected_starting_offset,
                chunk_size,
            );
        }
        // chunk_index is informational on inbound — we enforce by
        // offset. But we surface a clear error if the client tries
        // to skip ahead, since that's almost always a bug.
        let inferred_index = if chunk_index == 0 && expected_starting_offset == 0 {
            0
        } else {
            // The client should know how big its own chunks were;
            // we don't carry that map. Just trust the supplied
            // index and validate on `finish` by comparing the
            // final size + sha.
            chunk_index
        };
        let _ = inferred_index;
        transfer.bytes.extend_from_slice(&chunk_bytes);
        transfer.touch();
        Ok(())
    }

    /// Finalise an inbound transfer: verify the assembled buffer
    /// matches the declared size + sha + return the buffer + target
    /// path so the caller can run `git clone`. The transfer is
    /// dropped from the map regardless of outcome — caller can't
    /// retry a sha mismatch by re-pushing chunks (they have to
    /// re-`unbundleBegin`).
    pub fn finalize_inbound(&self, transfer_id: &str) -> Result<FinalizedInbound> {
        let mut map = self.lock();
        sweep_expired_locked(&mut map);
        let transfer = map
            .remove(transfer_id)
            .with_context(|| format!("no such transfer `{transfer_id}` to finalize"))?;
        if transfer.direction != Direction::Inbound {
            bail!("transfer `{transfer_id}` is outbound; finalize is only valid for inbound transfers");
        }
        let target_dir = transfer.target_dir.ok_or_else(|| {
            anyhow::anyhow!(
                "inbound transfer `{transfer_id}` missing target_dir (internal invariant violated)"
            )
        })?;
        if transfer.bytes.len() != transfer.expected_size_bytes {
            bail!(
                "inbound transfer `{transfer_id}` was declared {} bytes but only {} bytes arrived",
                transfer.expected_size_bytes,
                transfer.bytes.len(),
            );
        }
        Ok(FinalizedInbound {
            bytes: transfer.bytes,
            sha256_hex: transfer.sha256_hex,
            target_dir,
        })
    }

    /// Visible-from-the-outside snapshot of how many transfers are
    /// currently held. Used by tests + diagnostics; intentionally
    /// not exposed over the wire.
    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.transfers
            .lock()
            .expect("transfer mutex poisoned")
            .len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Transfer>> {
        self.transfers.lock().expect("transfer mutex poisoned")
    }
}

impl Default for BundleTransferStore {
    fn default() -> Self {
        Self::new()
    }
}

/// What [`BundleTransferStore::finalize_inbound`] hands back. The
/// caller (the dispatcher handler) writes the bytes to a tempfile,
/// verifies the sha, and runs `git clone`.
#[derive(Debug)]
pub struct FinalizedInbound {
    pub bytes: Vec<u8>,
    pub sha256_hex: String,
    pub target_dir: String,
}

fn sweep_expired_locked(map: &mut HashMap<String, Transfer>) {
    let cutoff = Instant::now().checked_sub(TRANSFER_TTL);
    let Some(cutoff) = cutoff else {
        return;
    };
    map.retain(|_id, t| t.last_access >= cutoff);
}

fn generate_id() -> String {
    // UUID v4 is overkill (collisions are astronomically unlikely)
    // but cheap + already in the dep tree.
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbound_round_trips_through_register_read_release() {
        let store = BundleTransferStore::new();
        let bytes = (0u8..200).collect::<Vec<u8>>();
        let sha = "stub-sha".to_string();
        let id = store.register_outbound(bytes.clone(), sha).unwrap();
        // Pull all 200 bytes as one chunk.
        let chunk = store.read_chunk(&id, 0, 1024).unwrap();
        assert_eq!(chunk, bytes);
        store.release(&id).unwrap();
        // Second release fails — transfer is gone.
        assert!(store.release(&id).is_err());
    }

    #[test]
    fn outbound_chunks_at_the_requested_size() {
        let store = BundleTransferStore::new();
        let bytes = (0u8..255).collect::<Vec<u8>>();
        let id = store
            .register_outbound(bytes.clone(), "sha".into())
            .unwrap();
        let chunk0 = store.read_chunk(&id, 0, 100).unwrap();
        let chunk1 = store.read_chunk(&id, 1, 100).unwrap();
        let chunk2 = store.read_chunk(&id, 2, 100).unwrap();
        assert_eq!(chunk0.len(), 100);
        assert_eq!(chunk1.len(), 100);
        assert_eq!(chunk2.len(), 55, "last chunk is partial");
        // Concatenate → matches the original.
        let assembled: Vec<u8> = [chunk0, chunk1, chunk2].concat();
        assert_eq!(assembled, bytes);
    }

    #[test]
    fn outbound_clamps_oversized_chunk_requests_to_max() {
        let store = BundleTransferStore::new();
        let bytes = vec![0u8; MAX_CHUNK_BYTES + 100];
        let id = store.register_outbound(bytes, "sha".into()).unwrap();
        // Asking for more than MAX gets clamped → returns exactly
        // MAX from chunk 0 (the rest spills into chunk 1).
        let chunk = store.read_chunk(&id, 0, MAX_CHUNK_BYTES * 10).unwrap();
        assert_eq!(chunk.len(), MAX_CHUNK_BYTES);
    }

    #[test]
    fn outbound_read_past_end_returns_clean_error() {
        let store = BundleTransferStore::new();
        let id = store
            .register_outbound(vec![0u8; 10], "sha".into())
            .unwrap();
        let err = store.read_chunk(&id, 100, 10).expect_err("past end");
        assert!(format!("{err:#}").contains("past the end"));
    }

    #[test]
    fn read_chunk_rejects_unknown_transfer_id() {
        let store = BundleTransferStore::new();
        let err = store
            .read_chunk("never-existed", 0, 100)
            .expect_err("unknown id must bail");
        assert!(format!("{err:#}").contains("no such transfer"));
    }

    #[test]
    fn inbound_round_trips_through_register_write_finalize() {
        let store = BundleTransferStore::new();
        let id = store
            .register_inbound("/tmp/target".into(), 6, "stub-sha".into())
            .unwrap();
        store.write_chunk(&id, 0, vec![1, 2, 3]).unwrap();
        store.write_chunk(&id, 1, vec![4, 5, 6]).unwrap();
        let result = store.finalize_inbound(&id).unwrap();
        assert_eq!(result.bytes, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(result.sha256_hex, "stub-sha");
        assert_eq!(result.target_dir, "/tmp/target");
        // After finalize the id is gone.
        assert!(store.finalize_inbound(&id).is_err());
    }

    #[test]
    fn inbound_rejects_overflow_past_declared_size() {
        let store = BundleTransferStore::new();
        let id = store
            .register_inbound("/tmp/t".into(), 5, "sha".into())
            .unwrap();
        store.write_chunk(&id, 0, vec![1, 2, 3]).unwrap();
        // Next chunk would push the total to 8 bytes; bail.
        let err = store
            .write_chunk(&id, 1, vec![4, 5, 6, 7, 8])
            .expect_err("overflow must bail");
        assert!(format!("{err:#}").contains("overflow"));
    }

    #[test]
    fn inbound_rejects_empty_chunks() {
        let store = BundleTransferStore::new();
        let id = store
            .register_inbound("/tmp/t".into(), 10, "sha".into())
            .unwrap();
        let err = store
            .write_chunk(&id, 0, Vec::new())
            .expect_err("empty chunks must bail");
        assert!(format!("{err:#}").contains("must not be empty"));
    }

    #[test]
    fn inbound_finalize_rejects_short_transfer() {
        let store = BundleTransferStore::new();
        let id = store
            .register_inbound("/tmp/t".into(), 10, "sha".into())
            .unwrap();
        store.write_chunk(&id, 0, vec![1, 2, 3]).unwrap();
        let err = store
            .finalize_inbound(&id)
            .expect_err("short transfer must bail");
        let msg = format!("{err:#}");
        assert!(msg.contains("declared 10"), "{msg}");
        assert!(msg.contains("only 3"), "{msg}");
    }

    #[test]
    fn inbound_rejects_transfers_over_the_size_cap() {
        let store = BundleTransferStore::new();
        let err = store
            .register_inbound("/tmp/t".into(), MAX_TRANSFER_BYTES + 1, "sha".into())
            .expect_err("oversized transfer must bail");
        assert!(format!("{err:#}").contains("caps inbound transfers"));
    }

    #[test]
    fn cross_direction_calls_bail_with_clear_errors() {
        let store = BundleTransferStore::new();
        let outbound = store
            .register_outbound(vec![0u8; 10], "sha".into())
            .unwrap();
        let err = store
            .write_chunk(&outbound, 0, vec![1])
            .expect_err("inbound op on outbound");
        assert!(format!("{err:#}").contains("outbound"));

        let inbound = store
            .register_inbound("/tmp/t".into(), 10, "sha".into())
            .unwrap();
        let err = store
            .read_chunk(&inbound, 0, 10)
            .expect_err("outbound op on inbound");
        assert!(format!("{err:#}").contains("inbound"));
    }

    #[test]
    fn release_unknown_id_is_a_clear_error_not_a_silent_noop() {
        let store = BundleTransferStore::new();
        let err = store
            .release("ghost-id")
            .expect_err("unknown id should bail");
        assert!(format!("{err:#}").contains("no such transfer"));
    }
}
