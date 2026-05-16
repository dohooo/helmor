//! Persistence layer for the runtime registry.
//!
//! Holds the registered-remotes list across app restarts so users
//! don't have to retype host + binary every boot. The on-disk shape
//! is a tiny versioned JSON file at
//! `<data_dir>/remote_runtimes.json` — matches the hand-written-JSON
//! pattern used elsewhere in the data dir.
//!
//! Failure modes are deliberately forgiving:
//!
//! - File missing → empty list, no error.
//! - File corrupt → log + treat as empty. We never refuse to boot
//!   over a malformed remotes file; the user can rebuild the list
//!   from the dev panel.
//! - Save failure → log + continue. A failed save shouldn't roll
//!   back the registration the user just made — the in-memory
//!   registry stays the source of truth for the running session.
//!
//! ## What is *not* stored
//!
//! Credentials (SSH keys, passwords, ssh-agent state) are never
//! captured. Only the reconnection metadata — name + connection
//! config — lands on disk. Anything auth-shaped is delegated to
//! `ssh` itself.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::client::{RemoteSshRuntime, RpcClient};
use super::connection::RuntimeConnectionConfig;
use super::methods::WorkspaceStatusResult;
use super::registry::{RuntimeRegistry, RuntimeState};
use super::runtime::{RemoteRuntime, RuntimeHealth, RuntimeKind};

/// Schema version on the persisted file. Bump when the on-disk
/// shape changes in a way the loader has to branch on.
const CURRENT_VERSION: u8 = 1;

/// Filename inside `<data_dir>`. Centralised so tests can override
/// via [`file_path`] under a tempdir.
const FILE_NAME: &str = "remote_runtimes.json";

/// One persisted entry — what's needed to reconnect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRuntimeEntry {
    pub name: String,
    pub config: RuntimeConnectionConfig,
}

/// File body. `version` lets the loader detect future schema
/// migrations; today there's only `1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRuntimes {
    pub version: u8,
    pub entries: Vec<PersistedRuntimeEntry>,
}

impl PersistedRuntimes {
    pub fn new(entries: Vec<PersistedRuntimeEntry>) -> Self {
        Self {
            version: CURRENT_VERSION,
            entries,
        }
    }

    pub fn empty() -> Self {
        Self::new(Vec::new())
    }
}

/// Path the persistence layer reads + writes. Public so tests and
/// the setup hook can hand the right path in without hard-coding
/// it.
pub fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Load the persisted list. Missing file → empty list, no error;
/// corrupt file → empty list + a warn-level log line (the user
/// can rebuild from the dev panel).
pub fn load(data_dir: &Path) -> PersistedRuntimes {
    let path = file_path(data_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            // Fresh install — perfectly normal.
            return PersistedRuntimes::empty();
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "remote-runner: failed to read persisted runtimes; starting with empty list"
            );
            return PersistedRuntimes::empty();
        }
    };
    match serde_json::from_str::<PersistedRuntimes>(&raw) {
        Ok(parsed) => parsed,
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "remote-runner: persisted runtimes file is malformed; starting with empty list"
            );
            PersistedRuntimes::empty()
        }
    }
}

/// Atomically rewrite the file. Writes through a `.tmp` sibling then
/// renames so a crash mid-write leaves the previous file intact.
/// Failures log but don't propagate — losing a save shouldn't break
/// the running session.
pub fn save(data_dir: &Path, snapshot: &PersistedRuntimes) {
    if let Err(err) = save_inner(data_dir, snapshot) {
        tracing::warn!(
            error = %format!("{err:#}"),
            "remote-runner: failed to persist runtimes; in-memory state is still authoritative"
        );
    }
}

fn save_inner(data_dir: &Path, snapshot: &PersistedRuntimes) -> Result<()> {
    fs::create_dir_all(data_dir)
        .with_context(|| format!("create data dir {}", data_dir.display()))?;
    let final_path = file_path(data_dir);
    let tmp_path = final_path.with_extension("json.tmp");
    let serialised =
        serde_json::to_string_pretty(snapshot).context("serialise PersistedRuntimes to JSON")?;
    fs::write(&tmp_path, serialised).with_context(|| format!("write {}", tmp_path.display()))?;
    fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("rename {} → {}", tmp_path.display(), final_path.display()))?;
    Ok(())
}

/// Convenience: snapshot a registry's configs into a saveable shape.
pub fn snapshot_from_registry(registry: &RuntimeRegistry) -> PersistedRuntimes {
    let entries = registry
        .configs()
        .into_iter()
        .map(|(name, config)| PersistedRuntimeEntry { name, config })
        .collect();
    PersistedRuntimes::new(entries)
}

/// Build a live runtime from a stored config — the inverse of what
/// `connect_remote_runtime` / `connect_local_runtime` do at command
/// time. Used by both the boot reconnect path and the
/// `reconnect_remote_runtime` command.
///
/// Resolves the local-binary path the same way `connect_local_runtime`
/// does: explicit override → `$HELMOR_SERVER_PATH` →
/// `<exe_dir>/helmor-server`.
pub fn connect_from_config(config: &RuntimeConnectionConfig) -> Result<Arc<dyn RemoteRuntime>> {
    match config {
        RuntimeConnectionConfig::Local { binary_path } => {
            let resolved = match binary_path {
                Some(p) => PathBuf::from(p),
                None => resolve_local_helmor_server_path()?,
            };
            let label = resolved.display().to_string();
            let cmd = std::process::Command::new(&resolved);
            let client = RpcClient::connect_command(cmd, label.clone())?;
            let runtime = RemoteSshRuntime::new(client, label);
            Ok(Arc::new(runtime))
        }
        RuntimeConnectionConfig::Ssh {
            host,
            remote_binary,
        } => {
            // Mirror the auto-install path that
            // `connect_remote_runtime` runs on first connect — the
            // operator-supplied `remote_binary` might still resolve
            // fine, but on a fresh remote (or after a Helmor server
            // upgrade) the install step takes care of placing the
            // binary at the managed location. Idempotent: a probe-
            // only path on hosts that already have the binary.
            let local_binary = resolve_local_helmor_server_path().ok();
            let resolved_binary = match local_binary {
                Some(local) => super::install::ensure_remote_helmor_server(
                    &super::install::ProcessSshRunner,
                    host,
                    remote_binary,
                    &local,
                )?,
                // No local binary available (release build with no
                // ssh-cm sibling, weird sandbox). Skip auto-install
                // and hope the operator-supplied path works.
                None => remote_binary.clone(),
            };
            let runtime = RemoteSshRuntime::connect_ssh(host, &resolved_binary)?;
            Ok(Arc::new(runtime))
        }
    }
}

/// Mirrors the path resolution in `commands::remote_commands`.
/// Duplicated here so the persistence layer doesn't reach into the
/// commands module — the boot-time restore happens before the
/// command layer is fully wired anyway.
fn resolve_local_helmor_server_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("HELMOR_SERVER_PATH") {
        let path = PathBuf::from(&p);
        if path.is_file() {
            return Ok(path);
        }
        anyhow::bail!("HELMOR_SERVER_PATH points to `{p}` which is not a file");
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) {
                "helmor-server.exe"
            } else {
                "helmor-server"
            };
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    anyhow::bail!(
        "helmor-server binary not found next to the running app. \
         Build it with `cargo build --bin helmor-server` or set HELMOR_SERVER_PATH."
    )
}

/// Walk the persisted list and either reconnect each entry or land
/// it as a tombstone with `RuntimeState::Disconnected`. Runs on the
/// blocking pool — both SSH and the local-binary path are sync —
/// so the setup hook fires it via `spawn_blocking`.
///
/// The user-facing trade-off: failed reconnects stay in the registry
/// so the dev panel can offer a "Reconnect" affordance, but the
/// inner trait object is a stub that errors on every call. The
/// liveness loop happily keeps it Disconnected; nothing reads from
/// it unless the user explicitly invokes it.
pub fn restore_on_startup(registry: &RuntimeRegistry, persisted: PersistedRuntimes) {
    for entry in persisted.entries {
        let label = entry.config.describe();
        match connect_from_config(&entry.config) {
            Ok(runtime) => {
                if let Err(err) =
                    registry.register(entry.name.clone(), runtime, Some(entry.config.clone()))
                {
                    tracing::warn!(
                        name = %entry.name,
                        config = %label,
                        error = %format!("{err:#}"),
                        "remote-runner: failed to register restored runtime"
                    );
                }
            }
            Err(err) => {
                let reason = format!("reconnect failed: {err:#}");
                tracing::info!(
                    name = %entry.name,
                    config = %label,
                    error = %reason,
                    "remote-runner: persisted runtime is a tombstone until user reconnects"
                );
                let tombstone: Arc<dyn RemoteRuntime> = Arc::new(TombstoneRuntime {
                    name: entry.name.clone(),
                    reason: reason.clone(),
                });
                if let Err(register_err) = registry.register_with_state(
                    entry.name.clone(),
                    tombstone,
                    Some(entry.config.clone()),
                    RuntimeState::Disconnected { reason },
                ) {
                    tracing::warn!(
                        name = %entry.name,
                        error = %format!("{register_err:#}"),
                        "remote-runner: failed to land tombstone for unreachable runtime"
                    );
                }
            }
        }
    }
}

/// Stand-in trait impl for entries whose reconnect failed at boot.
/// Every method errors with a fixed reason — the entry exists only
/// to surface in the dev panel and accept a `reconnect` command. The
/// liveness loop will keep pinging it (and failing), which is wasted
/// work but harmless given the 10s cadence.
pub struct TombstoneRuntime {
    name: String,
    reason: String,
}

impl TombstoneRuntime {
    pub fn new(name: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            reason: reason.into(),
        }
    }
}

impl RemoteRuntime for TombstoneRuntime {
    fn runtime_health(&self) -> Result<RuntimeHealth> {
        // Synthesise just enough for the chip — the actual transport
        // isn't reachable, so `hostname` and `version` are unknown.
        Ok(RuntimeHealth {
            kind: RuntimeKind::Remote {
                host: self.name.clone(),
            },
            hostname: "(unreachable)".into(),
            version: "(unreachable)".into(),
        })
    }

    fn workspace_status(&self, _: &Path) -> Result<WorkspaceStatusResult> {
        anyhow::bail!(
            "runtime `{}` is disconnected: {}. Reconnect from Settings → Runtime Debug.",
            self.name,
            self.reason
        )
    }

    fn ping(&self) -> Result<()> {
        anyhow::bail!("runtime `{}` is disconnected", self.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn dir() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn load_missing_file_returns_empty_without_error() {
        let d = dir();
        let loaded = load(d.path());
        assert_eq!(loaded.version, CURRENT_VERSION);
        assert!(loaded.entries.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_entries() {
        let d = dir();
        let snapshot = PersistedRuntimes::new(vec![
            PersistedRuntimeEntry {
                name: "stage".into(),
                config: RuntimeConnectionConfig::Local { binary_path: None },
            },
            PersistedRuntimeEntry {
                name: "dev.box".into(),
                config: RuntimeConnectionConfig::Ssh {
                    host: "dev.box".into(),
                    remote_binary: "helmor-server".into(),
                },
            },
        ]);
        save(d.path(), &snapshot);

        let loaded = load(d.path());
        assert_eq!(loaded, snapshot);
    }

    #[test]
    fn save_is_atomic_via_tmp_rename() {
        // The temp file shouldn't linger after a successful save.
        let d = dir();
        save(d.path(), &PersistedRuntimes::empty());
        let tmp = file_path(d.path()).with_extension("json.tmp");
        assert!(!tmp.exists(), "tmp file should be cleaned up by rename");
        assert!(file_path(d.path()).exists());
    }

    #[test]
    fn load_with_malformed_file_returns_empty_and_does_not_panic() {
        let d = dir();
        fs::write(file_path(d.path()), "{not json").unwrap();
        let loaded = load(d.path());
        assert!(loaded.entries.is_empty());
    }

    #[test]
    fn wire_format_uses_camel_case_keys() {
        let snapshot = PersistedRuntimes::new(vec![PersistedRuntimeEntry {
            name: "x".into(),
            config: RuntimeConnectionConfig::Ssh {
                host: "h".into(),
                remote_binary: "b".into(),
            },
        }]);
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert!(wire.contains("\"version\""));
        assert!(wire.contains("\"entries\""));
        assert!(wire.contains("\"remoteBinary\""));
        assert!(!wire.contains("remote_binary"), "snake_case leaked: {wire}");
    }

    // ── snapshot_from_registry ──────────────────────────────────

    #[test]
    fn snapshot_from_registry_includes_only_entries_with_config() {
        use crate::remote::runtime::{LocalRuntime, RemoteRuntime};
        use std::sync::Arc;

        let registry = RuntimeRegistry::new();
        let runtime: Arc<dyn RemoteRuntime> =
            Arc::new(LocalRuntime::with_hostname("dev-tag".into()));
        registry
            .register(
                "saved",
                runtime.clone(),
                Some(RuntimeConnectionConfig::Local { binary_path: None }),
            )
            .unwrap();
        registry
            .register("transient", runtime, None) // no config
            .unwrap();

        let snapshot = snapshot_from_registry(&registry);
        assert_eq!(
            snapshot.entries.len(),
            1,
            "entries with config=None must not be persisted"
        );
        assert_eq!(snapshot.entries[0].name, "saved");
    }

    // ── tombstone behaviour ──────────────────────────────────────

    #[test]
    fn tombstone_runtime_errors_on_workspace_status_and_ping_but_reports_health() {
        let t = TombstoneRuntime::new("dev.box", "ssh exited");
        // runtime_health succeeds — needed so the chip can render.
        let h = t.runtime_health().unwrap();
        match h.kind {
            RuntimeKind::Remote { host } => assert_eq!(host, "dev.box"),
            other => panic!("expected Remote, got {other:?}"),
        }
        // ping + workspace_status error so anything trying to actually
        // use the tombstone fails loud.
        assert!(t.ping().is_err());
        assert!(t.workspace_status(std::path::Path::new("/tmp")).is_err());
        // Workspace status error should mention the reason so the UI
        // can show it.
        let err = t
            .workspace_status(std::path::Path::new("/tmp"))
            .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("ssh exited"), "should preserve reason: {msg}");
    }

    // ── restore_on_startup ──────────────────────────────────────

    /// Always-successful no-op runtime used by restore_on_startup
    /// happy-path test. We can't easily wire connect_from_config
    /// against a real binary in a unit test, so we exercise the
    /// register/tombstone branching by feeding a known-bad SSH
    /// config (no `ssh` reachability) and asserting the tombstone
    /// path runs.
    #[test]
    fn restore_on_startup_lands_unreachable_entries_as_tombstones() {
        use crate::remote::registry::RuntimeState;

        let registry = RuntimeRegistry::new();
        // Bogus binary path — connect_from_config will fail at spawn
        // time because the file doesn't exist.
        let persisted = PersistedRuntimes::new(vec![PersistedRuntimeEntry {
            name: "ghost".into(),
            config: RuntimeConnectionConfig::Local {
                binary_path: Some("/definitely/not/a/real/binary".into()),
            },
        }]);
        restore_on_startup(&registry, persisted);

        // Entry is registered as a tombstone with Disconnected state.
        let state = registry.state("ghost").expect("entry should exist");
        match state {
            RuntimeState::Disconnected { reason } => {
                assert!(
                    reason.contains("reconnect failed"),
                    "reason should prefix with 'reconnect failed': {reason}"
                );
            }
            other => panic!("expected Disconnected, got {other:?}"),
        }
        // And the config survives so the user can hit Reconnect.
        assert!(registry.config_for("ghost").is_some());
    }

    #[test]
    fn restore_on_startup_with_empty_persisted_list_is_a_noop() {
        let registry = RuntimeRegistry::new();
        restore_on_startup(&registry, PersistedRuntimes::empty());
        assert_eq!(registry.configs().len(), 0);
        assert_eq!(registry.names(), vec!["local".to_string()]);
    }
}
