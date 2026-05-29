//! Server-side agent bridge (phase 23b).
//!
//! `RemoteAgentState` owns the daemon's connection to a `helmor-sidecar`
//! subprocess. Each `agent.send` RPC translates to a `SidecarRequest`
//! line written to the sidecar's stdin; every line the sidecar emits
//! on stdout is parsed, demuxed by the `id` field, and pushed back as
//! an `agent.event` notification to the per-session notifier.
//!
//! ## Module layout
//!
//! - [`spawner`] — `AgentSpawner` trait + production binary spawner.
//! - [`secrets`] — `$HOME/.helmor/server/secrets.json` store.
//! - [`mock`] (test-only) — in-memory spawner that drives a canned
//!   event stream without a real binary.
//!
//! ## Design
//!
//! - **One sidecar process per daemon.** Lazy spawn on the first
//!   `send()`; the same process serves every subsequent request.
//!   Mirrors how the desktop's [`crate::sidecar::ManagedSidecar`]
//!   works today, just on the remote side of the SSH pipe.
//! - **Per-request session map.** `agent.send` registers a session
//!   keyed by `request_id` before writing to stdin so the reader
//!   thread can route every inbound event back to the right
//!   notifier. The desktop's local pipeline has been doing this
//!   since phase 14; we're applying the same pattern remote-side.
//! - **Per-session notifier swap.** `agent.attach` replaces the
//!   notifier on an existing session — same primitive as
//!   [`super::terminal`]'s `replace_notifier`. Phase 23b implements
//!   the wire shape; phase 23d makes the daemon actually outlive
//!   the client (today the sidecar stays alive as long as the
//!   daemon does, which is enough for the routing flip in 23c).
//! - **Spawner is a trait.** Production wires
//!   [`BinaryAgentSpawner`] against `HELMOR_SIDECAR_PATH`; tests
//!   inject `mock::MockAgentSpawner` with a hand-scripted event
//!   stream so the bridge surface can be exercised without spawning
//!   a real `helmor-sidecar` binary.

mod journal;
mod journal_store;
mod secrets;
mod spawner;

#[cfg(test)]
pub mod mock;

#[cfg(test)]
mod tests;

pub use journal_store::JOURNAL_SUBDIR;
pub use spawner::{AgentSpawner, BinaryAgentSpawner, SidecarPipe};

use journal::EventJournal;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use secrets::{default_secrets_path, load_secrets, save_secrets, ProviderSecret};

use super::methods::{
    AgentAbortParams, AgentAbortResult, AgentAttachParams, AgentAttachResult,
    AgentAuthStatusResult, AgentListResult, AgentSendParams, AgentSendResult, AgentSessionEntry,
    AgentSetAuthParams, AgentSetAuthResult, ProviderAuthStatus, AGENT_EVENT_METHOD,
};
use super::server::Notifier;

/// Shared registry of live agent sessions on the daemon. Attached to
/// [`super::server::ServerContext`] so the dispatcher handlers can
/// reach it without going through the runtime trait (the
/// `RemoteRuntime::agent_*` methods stay the desktop-side delegation
/// path; the server side routes here directly).
pub struct RemoteAgentState {
    spawner: Arc<dyn AgentSpawner>,
    sidecar: Mutex<Option<RunningSidecar>>,
    sessions: Arc<Mutex<HashMap<String, ActiveAgentSession>>>,
    /// Phase 24t: sessions whose journals exist on disk but whose
    /// sidecar process is gone (either because the original session
    /// ended cleanly OR because the daemon restarted mid-session).
    /// `agent.list` merges these in as `state: "endedReplayOnly"` and
    /// `agent.attach` flushes the on-disk journal through the new
    /// notifier so a desktop can browse / rebuild the conversation.
    ended_sessions: Arc<Mutex<HashMap<String, EndedAgentSession>>>,
    /// Set when the spawner returned an explicit "not configured"
    /// (e.g. env var missing). Distinct from "sidecar crashed" —
    /// the former is a static configuration error and the toast
    /// shouldn't suggest "try reconnecting".
    spawn_disabled_reason: Option<String>,
    /// Where to persist API keys pushed via `agent.setAuth`. Phase
    /// 23d default: `$HOME/.helmor/server/secrets.json` (mode 0600).
    /// `None` disables persistence — tests use this to drive the
    /// in-memory flow without touching the filesystem.
    secrets_path: Option<PathBuf>,
    /// Phase 24t: directory holding per-session journal files. When
    /// `None`, disk persistence is disabled (tests that don't care
    /// about durability). Production wires this to
    /// `$HOME/.helmor/server/journals/`.
    journal_dir: Option<PathBuf>,
}

impl RemoteAgentState {
    pub fn new(spawner: Arc<dyn AgentSpawner>) -> Self {
        Self {
            spawner,
            sidecar: Mutex::new(None),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            ended_sessions: Arc::new(Mutex::new(HashMap::new())),
            spawn_disabled_reason: None,
            secrets_path: default_secrets_path(),
            journal_dir: None,
        }
    }

    /// Override the secrets persistence target. Tests use this to
    /// point at a tempdir; production wires the path resolved by
    /// `default_secrets_path()`.
    pub fn with_secrets_path(mut self, path: Option<PathBuf>) -> Self {
        self.secrets_path = path;
        self
    }

    /// Phase 24t: wire the journal directory. Calling this enables
    /// per-session disk-backed journals, scans the directory for
    /// any existing JSONL files (surfacing them as
    /// `endedReplayOnly` sessions), and sweeps files older than
    /// the retention window (default 24h, overridable via
    /// `HELMOR_JOURNAL_RETENTION_HOURS`). Tests that need a real
    /// FS path use this; tests that don't care about durability
    /// leave it unset.
    pub fn with_journal_dir(mut self, dir: PathBuf) -> Self {
        // Best-effort sweep — failures get logged but don't block
        // daemon startup.
        match journal_store::sweep_expired_journals(&dir, journal_store::retention_from_env()) {
            Ok(removed) if removed > 0 => {
                tracing::info!(
                    journal_dir = %dir.display(),
                    removed,
                    "journal: swept expired files on startup"
                );
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    journal_dir = %dir.display(),
                    error = %format!("{err:#}"),
                    "journal: sweep failed; continuing without retention cleanup",
                );
            }
        }
        // Recover any surviving journals as ended sessions.
        match journal_store::scan_journal_dir(&dir) {
            Ok(recovered) => {
                let mut ended = self
                    .ended_sessions
                    .lock()
                    .expect("ended sessions mutex poisoned");
                for r in recovered {
                    ended.insert(
                        r.request_id.clone(),
                        EndedAgentSession {
                            request_id: r.request_id,
                            helmor_session_id: r.helmor_session_id,
                            provider: r.provider,
                            workspace_dir: r.workspace_dir,
                            started_at_ms: r.started_at_ms,
                            last_event_ms: r.last_event_ms,
                            last_seq: r.last_seq,
                            path: r.path,
                        },
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    journal_dir = %dir.display(),
                    error = %format!("{err:#}"),
                    "journal: scan failed; ended sessions list will be empty",
                );
            }
        }
        self.journal_dir = Some(dir);
        self
    }

    /// Construct a state that refuses to spawn. Used when the
    /// `HELMOR_SIDECAR_PATH` env var is missing on the daemon side —
    /// every `agent.*` call surfaces the explicit reason rather than
    /// the cryptic spawn-failure message.
    pub fn disabled(reason: impl Into<String>) -> Self {
        // The dummy spawner is never invoked; we early-return from
        // `ensure_running` based on `spawn_disabled_reason`.
        struct NeverSpawner;
        impl AgentSpawner for NeverSpawner {
            fn spawn(&self) -> Result<SidecarPipe> {
                bail!("spawn disabled")
            }
        }
        Self {
            spawner: Arc::new(NeverSpawner),
            sidecar: Mutex::new(None),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            ended_sessions: Arc::new(Mutex::new(HashMap::new())),
            spawn_disabled_reason: Some(reason.into()),
            // Disabled state never reaches the spawn path that would
            // push secrets to the sidecar; the secrets file still
            // gets written on `set_auth` so a later daemon restart
            // (after the env var is set) picks them up.
            secrets_path: default_secrets_path(),
            journal_dir: None,
        }
    }

    /// Send a `SidecarRequest` (built from the `agent.send` params)
    /// into the sidecar. Registers the session under `request_id`
    /// before writing so the reader thread can route inbound events
    /// back to the calling client's notifier.
    pub fn send(
        &self,
        params: AgentSendParams,
        notifier: Arc<dyn Notifier>,
    ) -> Result<AgentSendResult> {
        if params.request_id.trim().is_empty() {
            bail!("request_id must not be empty");
        }
        if params.method.trim().is_empty() {
            bail!("sidecar method name must not be empty");
        }
        self.ensure_running()?;

        // Register the session BEFORE writing to stdin so the reader
        // thread can't race past an event before the map has the
        // entry.
        let workspace_dir = params
            .params
            .get("workspace")
            .and_then(Value::as_str)
            .or_else(|| params.params.get("cwd").and_then(Value::as_str))
            .map(str::to_string);
        let helmor_session_id = params
            .params
            .get("helmorSessionId")
            .or_else(|| params.params.get("helmor_session_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let now = now_ms();
        // Phase 24t: wire a disk writer for this session's journal
        // when the daemon is configured with a journal dir. Failure
        // to open the file logs + falls back to in-memory-only mode
        // — losing durability is better than rejecting the send.
        let journal = match self.journal_dir.as_ref() {
            Some(dir) => {
                let path = dir.join(format!("{}.jsonl", params.request_id));
                match journal_store::JournalDiskWriter::open(path) {
                    Ok(writer) => EventJournal::default().with_disk_writer(writer),
                    Err(err) => {
                        tracing::warn!(
                            rid = %params.request_id,
                            error = %format!("{err:#}"),
                            "journal: failed to open disk file; using in-memory only",
                        );
                        EventJournal::default()
                    }
                }
            }
            None => EventJournal::default(),
        };
        let session = ActiveAgentSession {
            request_id: params.request_id.clone(),
            notifier: Arc::new(Mutex::new(notifier)),
            helmor_session_id: Mutex::new(helmor_session_id),
            provider: Mutex::new(None),
            workspace_dir: Mutex::new(workspace_dir),
            started_at_ms: now,
            last_event_ms: Mutex::new(now),
            journal: Mutex::new(journal),
        };
        // Phase 24t: re-sending a request_id that exists in the ended
        // map (e.g. daemon restarted, desktop is re-sending the same
        // logical session) takes over — drop the ended entry so
        // agent.list doesn't double-count.
        self.ended_sessions
            .lock()
            .expect("ended sessions mutex poisoned")
            .remove(&params.request_id);
        self.sessions
            .lock()
            .expect("agent sessions mutex poisoned")
            .insert(params.request_id.clone(), session);

        // The sidecar's wire envelope is `{ id, method, params }`.
        // Pre-phase-23 it matched `SidecarRequest`; we serialise
        // here directly to avoid pulling the type from
        // `crate::sidecar` (which we want to keep desktop-only).
        let request = json!({
            "id": params.request_id,
            "method": params.method,
            "params": params.params,
        });
        let line = serde_json::to_string(&request).context("serialise sidecar request")?;

        let pipe = self.sidecar.lock().expect("sidecar mutex poisoned");
        let running = pipe
            .as_ref()
            .ok_or_else(|| anyhow!("sidecar not running"))?;
        let mut writer = running.stdin.lock().expect("sidecar stdin mutex poisoned");
        writer
            .write_all(line.as_bytes())
            .context("write sidecar request")?;
        writer.write_all(b"\n").context("write sidecar newline")?;
        writer.flush().context("flush sidecar stdin")?;

        Ok(AgentSendResult { accepted: true })
    }

    /// Forward an abort request to the sidecar. Translates to a
    /// `SidecarRequest { method: "abort", params: { request_id: ... } }`
    /// — the sidecar's per-provider managers handle cancellation
    /// internally. This call returns as soon as the bytes are
    /// written; the actual cancellation surfaces as a terminating
    /// `agent.event` (typically `type: "error"` with code
    /// `aborted`).
    pub fn abort(&self, params: AgentAbortParams) -> Result<AgentAbortResult> {
        if params.request_id.trim().is_empty() {
            bail!("request_id must not be empty");
        }
        self.ensure_running()?;
        // The sidecar's `abort` method expects its own id alongside
        // the request_id of the stream to cancel. Generate a unique
        // id so the sidecar's request-response demuxer doesn't
        // collide with the ongoing sendMessage.
        let abort_id = format!("abort-{}", uuid::Uuid::new_v4());
        let request = json!({
            "id": abort_id,
            "method": "abort",
            "params": { "requestId": params.request_id },
        });
        let line = serde_json::to_string(&request).context("serialise abort request")?;

        let pipe = self.sidecar.lock().expect("sidecar mutex poisoned");
        let running = pipe
            .as_ref()
            .ok_or_else(|| anyhow!("sidecar not running"))?;
        let mut writer = running.stdin.lock().expect("sidecar stdin mutex poisoned");
        writer
            .write_all(line.as_bytes())
            .context("write abort request")?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        Ok(AgentAbortResult::default())
    }

    /// Snapshot every session — live + (24t) ended-replay-only — as
    /// an `AgentListResult`. Stable order: most recently started
    /// first across both groups.
    pub fn list(&self) -> AgentListResult {
        let mut entries: Vec<AgentSessionEntry> = {
            let sessions = self.sessions.lock().expect("agent sessions mutex poisoned");
            sessions
                .values()
                .map(|s| AgentSessionEntry {
                    request_id: s.request_id.clone(),
                    helmor_session_id: s
                        .helmor_session_id
                        .lock()
                        .expect("session field mutex poisoned")
                        .clone(),
                    provider: s
                        .provider
                        .lock()
                        .expect("session field mutex poisoned")
                        .clone(),
                    workspace_dir: s
                        .workspace_dir
                        .lock()
                        .expect("session field mutex poisoned")
                        .clone(),
                    started_at_ms: s.started_at_ms,
                    last_event_ms: *s
                        .last_event_ms
                        .lock()
                        .expect("session field mutex poisoned"),
                    state: super::methods::AgentSessionState::Live,
                })
                .collect()
        };
        // Phase 24t: merge in ended-replay-only sessions. The map's
        // entries get stable order from the same `started_at_ms`
        // sort below; tagging them `EndedReplayOnly` is what tells
        // the desktop's auto-attach hook to skip them.
        let ended = self
            .ended_sessions
            .lock()
            .expect("ended sessions mutex poisoned");
        for e in ended.values() {
            entries.push(AgentSessionEntry {
                request_id: e.request_id.clone(),
                helmor_session_id: e.helmor_session_id.clone(),
                provider: e.provider.clone(),
                workspace_dir: e.workspace_dir.clone(),
                started_at_ms: e.started_at_ms,
                last_event_ms: e.last_event_ms,
                state: super::methods::AgentSessionState::EndedReplayOnly,
            });
        }
        drop(ended);
        entries.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
        AgentListResult { sessions: entries }
    }

    /// Swap the notifier on an existing session and replay any
    /// journal entries the caller missed.
    ///
    /// `found=false` when the request id has no live session — the
    /// daemon never knew about it, or it ended before the client
    /// reattached.
    ///
    /// **Phase 24q-1 contract**: the sessions HashMap lock is held
    /// across notifier swap → journal snapshot → flush. The reader
    /// thread blocks on the same lock for its own append path, so
    /// the sequence is deterministic:
    ///
    /// 1. Live events with `seq ≤ snapshot_head` reach the OLD
    ///    notifier (already delivered before attach).
    /// 2. Flushed entries (`since_seq < seq ≤ snapshot_head`) reach
    ///    the new notifier in order via this call.
    /// 3. Live events with `seq > snapshot_head` reach the NEW
    ///    notifier as the reader thread emits them after the
    ///    sessions lock releases.
    ///
    /// Holding the HashMap lock during flush blocks reader threads
    /// for OTHER sessions too. The flush is bounded by the
    /// journal's capacity (1024 entries today), so the stall is
    /// short — fine for reattach which is rare.
    pub fn attach(
        &self,
        params: AgentAttachParams,
        notifier: Arc<dyn Notifier>,
    ) -> Result<AgentAttachResult> {
        // Live path: session is in the active map. Swap the
        // notifier + flush journal snapshot under the sessions lock.
        let sessions = self.sessions.lock().expect("agent sessions mutex poisoned");
        if let Some(session) = sessions.get(&params.request_id) {
            // Swap notifier first so the reader thread's NEXT append
            // routes to the new client. The journal snapshot below
            // covers everything up to the head the journal has right
            // now; events emitted after this point land via the new
            // notifier (and into the journal for any FUTURE reattach
            // off this same session).
            {
                let mut current = session
                    .notifier
                    .lock()
                    .expect("session notifier mutex poisoned");
                *current = Arc::clone(&notifier);
            }

            // Snapshot the journal under the same sessions lock so the
            // reader thread can't append between our swap and our
            // snapshot — out-of-order delivery to the new client is the
            // alternative.
            let snapshot = session
                .journal
                .lock()
                .expect("session journal mutex poisoned")
                .replay_since(params.since_seq);

            let entries = snapshot.entries;
            let replayed_count = entries.len() as u64;
            let request_id = params.request_id.clone();
            for entry in entries {
                notifier.notify(
                    AGENT_EVENT_METHOD,
                    json!({
                        "requestId": request_id,
                        "event": entry.payload,
                        "seq": entry.seq,
                    }),
                );
            }

            return Ok(AgentAttachResult {
                found: true,
                last_seq: snapshot.head_seq,
                replayed_count,
                replay_gap: snapshot.replay_gap,
            });
        }
        drop(sessions);

        // Phase 24t: replay-only path. The original sidecar process
        // is gone, but the on-disk journal survives. Read the file +
        // flush entries newer than `since_seq` through the supplied
        // notifier. No notifier swap (there's no future event to
        // route); the desktop sees the full replay terminated by the
        // original `result`/`end` event the journal already holds.
        let ended_path = {
            let ended = self
                .ended_sessions
                .lock()
                .expect("ended sessions mutex poisoned");
            ended.get(&params.request_id).map(|e| e.path.clone())
        };
        let Some(path) = ended_path else {
            return Ok(AgentAttachResult::default());
        };
        let entries = journal_store::read_journal_entries(&path)
            .with_context(|| format!("replay from on-disk journal {}", path.display()))?;
        let head_seq = entries.last().map(|e| e.seq).unwrap_or(0);
        let cutoff = params.since_seq.unwrap_or(0);
        // Detect a replay gap by checking whether the file's first
        // surviving entry is past the caller's expected next seq. On
        // disk we never evict, so the only way to hit this is if
        // the daemon was started with a partially-truncated journal.
        let replay_gap = entries
            .first()
            .filter(|first| first.seq > cutoff.saturating_add(1) && cutoff > 0)
            .map(|first| first.seq);
        let to_flush: Vec<_> = entries.into_iter().filter(|e| e.seq > cutoff).collect();
        let replayed_count = to_flush.len() as u64;
        let request_id = params.request_id.clone();
        for entry in to_flush {
            notifier.notify(
                AGENT_EVENT_METHOD,
                json!({
                    "requestId": request_id,
                    "event": entry.payload,
                    "seq": entry.seq,
                }),
            );
        }
        Ok(AgentAttachResult {
            found: true,
            last_seq: head_seq,
            replayed_count,
            replay_gap,
        })
    }

    /// Persist an SDK API key (or clear it) and hot-push the change
    /// to the live sidecar via `updateConfig`. Idempotent: setting
    /// the same value twice is a no-op on the wire (the sidecar
    /// re-receives the same config blob, which is cheap on the
    /// receiving end). Clearing a never-set provider is also a
    /// no-op.
    pub fn set_auth(&self, params: AgentSetAuthParams) -> Result<AgentSetAuthResult> {
        if params.provider.trim().is_empty() {
            bail!("provider must not be empty");
        }
        // Persist first, push second. If the persistence fails, the
        // hot-push would create state drift on the next sidecar
        // restart (the secrets file disagrees with the live
        // config). Order matters.
        let mut store = self
            .secrets_path
            .as_ref()
            .map(|path| load_secrets(path).unwrap_or_default())
            .unwrap_or_default();
        match params.api_key.as_deref().map(str::trim) {
            Some("") | None => {
                store.providers.remove(&params.provider);
            }
            Some(key) => {
                store.providers.insert(
                    params.provider.clone(),
                    ProviderSecret {
                        api_key: Some(key.to_string()),
                        base_url: params.base_url.clone(),
                    },
                );
            }
        }
        if let Some(path) = self.secrets_path.as_ref() {
            save_secrets(path, &store)
                .with_context(|| format!("persist agent secrets to {} failed", path.display()))?;
        }

        // Hot-push to the live sidecar if it's running. The
        // `cursor` provider is the only one the sidecar's
        // `updateConfig` understands today; other providers persist
        // but don't get a live push (the per-request params on
        // `agent.send` carry their credentials directly). When a
        // future provider needs hot-push, add a branch here.
        if params.provider == "cursor" {
            self.push_cursor_key(params.api_key.clone());
        }
        Ok(AgentSetAuthResult::default())
    }

    /// Track G2 read side: snapshot which providers have a key
    /// configured without ever returning the literal value.
    /// Surfaces `configured: bool` + the optional `base_url` so the
    /// desktop can render a chip on each remote-server row + a
    /// "Currently configured" line in the auth dialog.
    ///
    /// Empty list when no auth has been written (fresh daemon, or
    /// the operator cleared every key). Missing secrets file is
    /// treated as "no entries" — same conservative fallback as
    /// [`set_auth`] uses.
    pub fn auth_status(&self) -> Result<AgentAuthStatusResult> {
        let store = self
            .secrets_path
            .as_ref()
            .map(|path| load_secrets(path).unwrap_or_default())
            .unwrap_or_default();
        let mut providers: Vec<ProviderAuthStatus> = store
            .providers
            .iter()
            .map(|(name, secret)| ProviderAuthStatus {
                provider: name.clone(),
                // Only treat a non-empty `api_key` as configured. An
                // empty string in the store would be a bug, but we
                // surface it as "not configured" so the chip doesn't
                // flash green on stale state.
                configured: secret
                    .api_key
                    .as_deref()
                    .map(|k| !k.is_empty())
                    .unwrap_or(false),
                base_url: secret.base_url.clone(),
            })
            .collect();
        providers.sort_by(|a, b| a.provider.cmp(&b.provider));
        Ok(AgentAuthStatusResult { providers })
    }

    /// Send an `updateConfig` SidecarRequest carrying the current
    /// Cursor API key (or `null` to clear). No-op when the sidecar
    /// isn't running — the next `ensure_running` re-pushes the
    /// stored value.
    fn push_cursor_key(&self, key: Option<String>) {
        let pipe = self.sidecar.lock().expect("sidecar mutex poisoned");
        let Some(running) = pipe.as_ref() else {
            return;
        };
        let request = json!({
            "id": format!("auth-{}", uuid::Uuid::new_v4()),
            "method": "updateConfig",
            "params": { "cursorApiKey": key },
        });
        let line = match serde_json::to_string(&request) {
            Ok(s) => s,
            Err(err) => {
                tracing::warn!(error = %err, "agent.setAuth: failed to serialise updateConfig");
                return;
            }
        };
        let mut writer = running.stdin.lock().expect("sidecar stdin mutex poisoned");
        if let Err(err) = writer
            .write_all(line.as_bytes())
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
        {
            tracing::warn!(error = %err, "agent.setAuth: updateConfig push failed");
        }
    }

    /// Spawn the sidecar on first use. Subsequent calls are a
    /// no-op. Drops the lock between the handshake read and the
    /// reader-thread spawn so per-call latency stays bounded.
    fn ensure_running(&self) -> Result<()> {
        if let Some(reason) = self.spawn_disabled_reason.as_deref() {
            bail!("agent runtime is not available: {reason}");
        }
        let mut pipe = self.sidecar.lock().expect("sidecar mutex poisoned");
        if pipe.is_some() {
            return Ok(());
        }

        let mut spawned = self.spawner.spawn()?;
        // Drain the sidecar's handshake line. Real sidecar emits
        // `{"type":"ready"}` once its event loop is up; the mock
        // does the same so this path doesn't fork.
        let mut handshake = String::new();
        spawned
            .stdout
            .read_line(&mut handshake)
            .context("read sidecar handshake")?;
        let parsed: Value = serde_json::from_str(handshake.trim())
            .with_context(|| format!("parse sidecar handshake: {handshake:?}"))?;
        if parsed.get("type").and_then(Value::as_str) != Some("ready") {
            bail!("sidecar handshake was not type=ready: {parsed}");
        }

        let stdin = Arc::new(Mutex::new(spawned.stdin));
        let stop = Arc::new(AtomicBool::new(false));
        let reader = spawn_reader_thread(
            spawned.stdout,
            Arc::clone(&self.sessions),
            Arc::clone(&self.ended_sessions),
            Arc::clone(&stop),
            spawned.label.clone(),
        );
        *pipe = Some(RunningSidecar {
            stdin,
            _reader: reader,
            _child: spawned.child,
            stop,
        });
        // Push any persisted secrets so the sidecar's first
        // provider call lands with auth set. Done after the
        // RunningSidecar lands in `pipe` so `push_cursor_key` finds
        // it; we hold the same `pipe` lock, so the push happens
        // before any other `send()` can race in.
        if let Some(cursor_key) = self
            .secrets_path
            .as_ref()
            .and_then(|p| load_secrets(p).ok())
            .and_then(|s| s.providers.get("cursor").cloned())
            .and_then(|s| s.api_key)
        {
            // Drop the outer pipe lock first so push_cursor_key can
            // reacquire it without deadlocking. Mutex is non-
            // reentrant.
            drop(pipe);
            self.push_cursor_key(Some(cursor_key));
        }
        Ok(())
    }
}

impl Drop for RemoteAgentState {
    fn drop(&mut self) {
        // Signal the reader thread to stop. Dropping the stdin
        // mutex closes the writer side, which makes the sidecar
        // notice EOF and exit; the reader thread sees EOF on its
        // own stdout and exits cleanly too.
        if let Some(running) = self.sidecar.lock().ok().and_then(|mut g| g.take()) {
            running.stop.store(true, Ordering::SeqCst);
            // Best-effort: kill + reap. Mirrors the desktop's
            // ManagedSidecar shutdown path.
            if let Some(mut child) = running._child {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

struct RunningSidecar {
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    _reader: JoinHandle<()>,
    _child: Option<Child>,
    stop: Arc<AtomicBool>,
}

/// Phase 24t: lightweight session entry rebuilt from an on-disk
/// journal whose original sidecar process is gone. Holds just enough
/// metadata for `agent.list` to surface the session + for
/// `agent.attach` to flush the journal file through the new notifier.
struct EndedAgentSession {
    request_id: String,
    helmor_session_id: Option<String>,
    provider: Option<String>,
    workspace_dir: Option<String>,
    started_at_ms: i64,
    last_event_ms: i64,
    /// Phase 24t: high-water-mark seq the daemon issued for this
    /// session, captured at the time it transitioned to ended.
    /// Logged when the session moves to the ended-sessions table so
    /// an operator chasing "where did the live tail end?" can
    /// correlate the daemon's view with the desktop's last
    /// persisted row. Not consumed by the replay path — the attach
    /// handler reads seqs back from the on-disk JSONL.
    last_seq: u64,
    path: PathBuf,
}

struct ActiveAgentSession {
    request_id: String,
    /// Per-session notifier slot. `agent.attach` replaces this so
    /// subsequent events flow to the new client. Stored behind a
    /// `Mutex` (not `RwLock`) because contention is rare and the
    /// lock window is just an `Arc::clone`.
    notifier: Arc<Mutex<Arc<dyn Notifier>>>,
    helmor_session_id: Mutex<Option<String>>,
    provider: Mutex<Option<String>>,
    workspace_dir: Mutex<Option<String>>,
    started_at_ms: i64,
    last_event_ms: Mutex<i64>,
    /// Phase 24q-1: bounded ring of recent sidecar events. Read by
    /// `agent.attach` to replay missed events to a reconnecting
    /// client (see [`journal`] for capacity + eviction semantics).
    /// Held behind `Mutex` rather than `RwLock` because every reader
    /// loop iteration appends (write-heavy access).
    journal: Mutex<EventJournal>,
}

fn spawn_reader_thread(
    stdout: Box<dyn BufRead + Send>,
    sessions: Arc<Mutex<HashMap<String, ActiveAgentSession>>>,
    ended_sessions: Arc<Mutex<HashMap<String, EndedAgentSession>>>,
    stop: Arc<AtomicBool>,
    label: String,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("helmor-agent-reader[{label}]"))
        .spawn(move || reader_loop(stdout, sessions, ended_sessions, stop, label))
        .expect("failed to spawn agent reader thread")
}

fn reader_loop(
    mut stdout: Box<dyn BufRead + Send>,
    sessions: Arc<Mutex<HashMap<String, ActiveAgentSession>>>,
    ended_sessions: Arc<Mutex<HashMap<String, EndedAgentSession>>>,
    stop: Arc<AtomicBool>,
    label: String,
) {
    let mut line = String::new();
    while !stop.load(Ordering::SeqCst) {
        line.clear();
        match stdout.read_line(&mut line) {
            Ok(0) => {
                tracing::debug!(label = %label, "agent reader: EOF; exiting");
                return;
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    label = %label,
                    error = %err,
                    "agent reader: read failed; exiting"
                );
                return;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(err) => {
                tracing::debug!(
                    label = %label,
                    error = %err,
                    line = %trimmed,
                    "agent reader: malformed event line; dropping",
                );
                continue;
            }
        };

        // Anchor every event to its request_id so the per-session
        // notifier is the right one. Events without an `id` are
        // sidecar-internal (heartbeats with no session context,
        // ready, etc.); drop them.
        let id = match value.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };

        let (notifier, completed, seq) = {
            let mut sessions_guard = sessions.lock().expect("agent sessions mutex poisoned");
            let Some(session) = sessions_guard.get_mut(&id) else {
                continue;
            };
            // Snapshot late-binding metadata when the sidecar
            // surfaces it. `system.init` carries the authoritative
            // `session_id`; the desktop also wants to know the
            // provider for the chip / reattach UX.
            if let Some(session_id) = value.get("session_id").and_then(Value::as_str) {
                let mut slot = session
                    .helmor_session_id
                    .lock()
                    .expect("session field mutex poisoned");
                if slot.is_none() {
                    *slot = Some(session_id.to_string());
                }
            }
            if let Some(provider) = value.get("provider").and_then(Value::as_str) {
                let mut slot = session
                    .provider
                    .lock()
                    .expect("session field mutex poisoned");
                if slot.is_none() {
                    *slot = Some(provider.to_string());
                }
            }
            *session
                .last_event_ms
                .lock()
                .expect("session field mutex poisoned") = now_ms();

            // Phase 24q-1: append to the journal BEFORE reading the
            // notifier. Holds the sessions HashMap lock for the
            // append so an `agent.attach` racing in can't observe
            // a notifier swap that's older than its journal
            // snapshot — the attach handler holds the same lock
            // through its swap+snapshot+flush sequence (see
            // `RemoteAgentState::attach`).
            let seq = session
                .journal
                .lock()
                .expect("session journal mutex poisoned")
                .append(value.clone());

            let notifier = session
                .notifier
                .lock()
                .expect("session notifier mutex poisoned")
                .clone();
            // Terminal lifecycle events end the session. Only the
            // sidecar's own control events (`end` / `aborted`) close
            // the lifecycle — the SDK's `result` event is *data*
            // (the final turn payload). The sidecar emits `result`
            // first and `end` AFTER it; if we treated `result` as
            // terminal here, we'd drop the session before the `end`
            // arrives, the desktop's stream loop (which only matches
            // `end`/`aborted`) never sees its terminator, and the
            // 45s heartbeat watchdog fires instead of a clean close.
            let completed = matches!(
                value.get("type").and_then(Value::as_str),
                Some("end") | Some("aborted")
            );
            (notifier, completed, seq)
        };

        notifier.notify(
            AGENT_EVENT_METHOD,
            json!({
                "requestId": id,
                "event": value,
                // Phase 24q-1 wire shape: the seq lets a desktop
                // track its high-water-mark per session so a future
                // reattach can ask for `since_seq`. Additive
                // backward-compatible field; older clients ignore
                // it.
                "seq": seq,
            }),
        );

        if completed {
            // Phase 24t: instead of dropping the session outright,
            // pluck out the metadata + journal path so we can surface
            // it through `agent.list` as `endedReplayOnly` and serve
            // future cold attaches from the on-disk file.
            let removed = sessions
                .lock()
                .expect("agent sessions mutex poisoned")
                .remove(&id);
            if let Some(active) = removed {
                if let Some(ended) = build_ended_from_active(active) {
                    tracing::info!(
                        request_id = %ended.request_id,
                        last_seq = %ended.last_seq,
                        path = %ended.path.display(),
                        "remote-runner: agent session moved to ended (replay-only) state",
                    );
                    ended_sessions
                        .lock()
                        .expect("ended sessions mutex poisoned")
                        .insert(id.clone(), ended);
                }
            }
        }
    }
}

/// Phase 24t: drain the metadata + disk-writer path out of an
/// `ActiveAgentSession` so the entry can move into the
/// `ended_sessions` map. Returns `None` when the journal has no disk
/// mirror — there's nothing to flush from, so a future
/// `agent.attach` couldn't serve the replay anyway.
fn build_ended_from_active(active: ActiveAgentSession) -> Option<EndedAgentSession> {
    let helmor_session_id = active.helmor_session_id.into_inner().ok().flatten();
    let provider = active.provider.into_inner().ok().flatten();
    let workspace_dir = active.workspace_dir.into_inner().ok().flatten();
    let last_event_ms = active.last_event_ms.into_inner().ok().unwrap_or(0);
    let journal = active.journal.into_inner().ok()?;
    let (last_seq, path) = journal.into_disk_path_and_head()?;
    Some(EndedAgentSession {
        request_id: active.request_id,
        helmor_session_id,
        provider,
        workspace_dir,
        started_at_ms: active.started_at_ms,
        last_event_ms,
        last_seq,
        path,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
