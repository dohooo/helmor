//! Desktop-side SSH port-forward manager + Tauri commands.
//!
//! Closes the biggest VS Code Remote-SSH parity gap: lets a
//! remote-side dev server (Vite, Rails, a notebook kernel, …)
//! show up at `localhost:N` on the desktop. Implementation
//! leverages OpenSSH's `-O forward` against the existing
//! ControlMaster connection — no parallel SSH spawn, no new
//! protocol over the JSON-RPC pipe, and no auth re-handshake.
//! The forward lives on the same TCP + auth channel the RPC
//! pipe already rides.
//!
//! Scope:
//! - Only SSH-shaped runtimes are supported (the ControlMaster
//!   layer is what gives us `-O forward`). Command / Local
//!   transports surface a legible "use the wrapper's own
//!   forwarding tool" error rather than degrading silently.
//! - Forwards are persisted to `<data_dir>/remote_port_forwards.json`
//!   so they survive a desktop restart; on boot we replay every
//!   entry whose runtime is still registered as SSH.
//! - The local bind is always `127.0.0.1:<local_port>` to match
//!   the spike's "this is a developer convenience" framing — no
//!   public-bind option, no IPv6, no GatewayPorts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::remote::{RuntimeConnectionConfig, RuntimeRegistry, LOCAL_RUNTIME_NAME};

use super::common::{run_blocking, CmdResult};

const PERSIST_FILENAME: &str = "remote_port_forwards.json";

/// Forward record — both the wire shape the frontend renders +
/// the persisted JSON entry. The two responsibilities collapse
/// because the same fields drive both surfaces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardEntry {
    pub runtime_name: String,
    pub local_port: u16,
    pub remote_port: u16,
    /// Optional human label — "Vite", "Rails", "Jupyter".
    /// Surfaces in the panel row so multiple forwards on one
    /// runtime stay distinguishable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Unix epoch ms when `ssh -O forward` reported success.
    /// Set on every fresh start; not persisted (re-set on
    /// restore) so the panel's "started 5m ago" chip reflects
    /// the current session.
    #[serde(default)]
    pub started_at_ms: i64,
}

/// Tauri-managed state. One Arc instance shared across every
/// command; the inner Mutex<HashMap> keeps lookups O(1) by
/// runtime name + lets `list` snapshot under a lock without
/// fanning out a clone per call.
#[derive(Default)]
pub struct RemotePortForwardManager {
    forwards: Mutex<HashMap<String, Vec<PortForwardEntry>>>,
}

impl RemotePortForwardManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sorted snapshot of all active forwards across every
    /// runtime. Used by the persistence layer + by tests.
    pub fn snapshot(&self) -> Vec<PortForwardEntry> {
        let guard = self
            .forwards
            .lock()
            .expect("port forward manager mutex poisoned");
        let mut out: Vec<PortForwardEntry> = guard.values().flatten().cloned().collect();
        out.sort_by(|a, b| {
            a.runtime_name
                .cmp(&b.runtime_name)
                .then(a.local_port.cmp(&b.local_port))
        });
        out
    }

    pub fn for_runtime(&self, name: &str) -> Vec<PortForwardEntry> {
        self.forwards
            .lock()
            .expect("port forward manager mutex poisoned")
            .get(name)
            .cloned()
            .unwrap_or_default()
    }
}

/// File-backed persistence. `<data_dir>/remote_port_forwards.json`
/// holds an array of every active forward; on boot we replay
/// each one whose runtime is still registered + SSH-shaped.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPortForwards {
    pub forwards: Vec<PortForwardEntry>,
}

pub fn persist_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PERSIST_FILENAME)
}

pub fn load_persisted(data_dir: &Path) -> PersistedPortForwards {
    let path = persist_file_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<PersistedPortForwards>(&raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    path = %path.display(),
                    "remote-runner: port-forward file is malformed; starting empty"
                );
                PersistedPortForwards::default()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => PersistedPortForwards::default(),
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "remote-runner: failed to read port-forward file; starting empty"
            );
            PersistedPortForwards::default()
        }
    }
}

pub fn save_persisted(data_dir: &Path, snapshot: &PersistedPortForwards) {
    if let Err(err) = save_persisted_inner(data_dir, snapshot) {
        tracing::warn!(
            error = %format!("{err:#}"),
            "remote-runner: failed to persist port forwards"
        );
    }
}

fn save_persisted_inner(data_dir: &Path, snapshot: &PersistedPortForwards) -> Result<()> {
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("create data dir {}", data_dir.display()))?;
    let final_path = persist_file_path(data_dir);
    let tmp_path = final_path.with_extension("json.tmp");
    let serialised = serde_json::to_string_pretty(snapshot)
        .context("serialise PersistedPortForwards to JSON")?;
    std::fs::write(&tmp_path, serialised)
        .with_context(|| format!("write {}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("rename {} -> {}", tmp_path.display(), final_path.display()))?;
    Ok(())
}

/// Resolve the SSH host for a runtime by name. Errors if the
/// runtime isn't registered, doesn't carry a persisted config,
/// or carries a non-SSH config. Returned host string goes
/// straight to `ssh <host>` for the `-O forward` invocation.
fn resolve_ssh_host(registry: &Arc<RuntimeRegistry>, name: &str) -> Result<String> {
    if name.trim().is_empty() {
        bail!("runtime name must not be empty");
    }
    if name == LOCAL_RUNTIME_NAME {
        bail!("port forwarding is only available on registered remote runtimes (got `{name}`)");
    }
    let config = registry.config_for(name).ok_or_else(|| {
        anyhow::anyhow!("runtime `{name}` is not registered (or has no persisted config)")
    })?;
    match config {
        RuntimeConnectionConfig::Ssh { host, .. } => Ok(host),
        RuntimeConnectionConfig::Command { .. } => bail!(
            "port forwarding is currently only supported on SSH-shaped runtimes — \
             use the wrapper's own forwarding tool (e.g. `tailscale ssh -L`, \
             `kubectl port-forward`) for `{name}`"
        ),
        RuntimeConnectionConfig::Local { .. } => {
            bail!("port forwarding does not apply to local runtimes (got `{name}`)")
        }
    }
}

/// Build the `ssh -O forward -L ...` command. Mirrors the
/// arg shape `OpenSshTransport::build_command` uses for its
/// own ControlMaster spawn so `-O forward` finds the master's
/// socket by ControlPath hash. Pure function; production +
/// tests share the same builder.
fn build_forward_command(
    host: &str,
    local_port: u16,
    remote_port: u16,
    control_dir: Option<&Path>,
) -> Command {
    let mut cmd = Command::new("ssh");
    // BatchMode keeps the call fast-failing instead of prompting
    // when the master needs a re-auth (it shouldn't — ControlPersist
    // is still alive — but defence in depth).
    cmd.arg("-o").arg("BatchMode=yes");
    if let Some(dir) = control_dir {
        cmd.arg("-o").arg("ControlMaster=auto");
        cmd.arg("-o").arg("ControlPersist=5m");
        cmd.arg("-o")
            .arg(format!("ControlPath={}/%C", dir.display()));
    }
    cmd.arg("-O").arg("forward");
    cmd.arg("-L")
        .arg(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
    cmd.arg(host);
    cmd
}

/// Build the `ssh -O cancel` counterpart. Same options as the
/// forward command so ssh resolves the same ControlPath socket.
fn build_cancel_command(
    host: &str,
    local_port: u16,
    remote_port: u16,
    control_dir: Option<&Path>,
) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    if let Some(dir) = control_dir {
        cmd.arg("-o").arg("ControlMaster=auto");
        cmd.arg("-o").arg("ControlPersist=5m");
        cmd.arg("-o")
            .arg(format!("ControlPath={}/%C", dir.display()));
    }
    cmd.arg("-O").arg("cancel");
    cmd.arg("-L")
        .arg(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
    cmd.arg(host);
    cmd
}

// ── start_remote_port_forward ───────────────────────────────────────

#[tauri::command]
pub async fn start_remote_port_forward(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    manager: tauri::State<'_, Arc<RemotePortForwardManager>>,
    runtime_name: String,
    local_port: u16,
    remote_port: u16,
    label: Option<String>,
) -> CmdResult<PortForwardEntry> {
    let registry = Arc::clone(&registry);
    let manager = Arc::clone(&manager);
    run_blocking(move || {
        start_remote_port_forward_inner(
            &registry,
            &manager,
            runtime_name,
            local_port,
            remote_port,
            label,
        )
    })
    .await
}

pub(crate) fn start_remote_port_forward_inner(
    registry: &Arc<RuntimeRegistry>,
    manager: &Arc<RemotePortForwardManager>,
    runtime_name: String,
    local_port: u16,
    remote_port: u16,
    label: Option<String>,
) -> Result<PortForwardEntry> {
    if local_port == 0 {
        bail!("local port must not be zero");
    }
    if remote_port == 0 {
        bail!("remote port must not be zero");
    }
    let host = resolve_ssh_host(registry, &runtime_name)?;

    // Refuse duplicates on (runtime, local_port). The OS would
    // reject the second `ssh -O forward` anyway with EADDRINUSE,
    // but the early bail surfaces a clearer "already forwarded"
    // message in the panel.
    {
        let guard = manager
            .forwards
            .lock()
            .expect("port forward manager mutex poisoned");
        if let Some(entries) = guard.get(&runtime_name) {
            if entries.iter().any(|e| e.local_port == local_port) {
                bail!("local port {local_port} is already forwarded on runtime `{runtime_name}`");
            }
        }
    }

    let control_dir = crate::remote::transport::ssh_control_dir();
    let mut cmd = build_forward_command(&host, local_port, remote_port, control_dir.as_deref());
    let output = cmd
        .output()
        .with_context(|| format!("spawn `ssh -O forward` for `{runtime_name}`"))?;
    if !output.status.success() {
        // Surface stderr verbatim so the operator can see the
        // OpenSSH-side error (port in use, master not running,
        // bad host alias, etc.).
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "ssh -O forward failed for `{runtime_name}` ({local_port}->{remote_port}): {}",
            if stderr.is_empty() {
                format!("exit {}", output.status)
            } else {
                stderr
            }
        );
    }

    let entry = PortForwardEntry {
        runtime_name: runtime_name.clone(),
        local_port,
        remote_port,
        label,
        started_at_ms: now_unix_ms(),
    };

    manager
        .forwards
        .lock()
        .expect("port forward manager mutex poisoned")
        .entry(runtime_name)
        .or_default()
        .push(entry.clone());

    persist_after_mutation(manager);
    Ok(entry)
}

/// Best-effort persistence write. Failures log + don't bubble —
/// losing a save shouldn't break the running session; the next
/// successful save catches up.
fn persist_after_mutation(manager: &Arc<RemotePortForwardManager>) {
    let Ok(dir) = crate::data_dir::data_dir() else {
        return;
    };
    let snapshot = PersistedPortForwards {
        forwards: manager.snapshot(),
    };
    save_persisted(&dir, &snapshot);
}

// ── stop_remote_port_forward ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopPortForwardResult {
    pub stopped: bool,
}

#[tauri::command]
pub async fn stop_remote_port_forward(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    manager: tauri::State<'_, Arc<RemotePortForwardManager>>,
    runtime_name: String,
    local_port: u16,
) -> CmdResult<StopPortForwardResult> {
    let registry = Arc::clone(&registry);
    let manager = Arc::clone(&manager);
    run_blocking(move || {
        stop_remote_port_forward_inner(&registry, &manager, runtime_name, local_port)
    })
    .await
}

pub(crate) fn stop_remote_port_forward_inner(
    registry: &Arc<RuntimeRegistry>,
    manager: &Arc<RemotePortForwardManager>,
    runtime_name: String,
    local_port: u16,
) -> Result<StopPortForwardResult> {
    if local_port == 0 {
        bail!("local port must not be zero");
    }

    // Pop the entry up front so the cancel call below has the
    // remote_port it needs without re-locking. If no entry
    // exists we still try a best-effort cancel so a stale
    // ssh-side forward (from a crashed prior process) gets
    // cleaned up.
    let removed = {
        let mut guard = manager
            .forwards
            .lock()
            .expect("port forward manager mutex poisoned");
        guard.get_mut(&runtime_name).and_then(|entries| {
            let idx = entries.iter().position(|e| e.local_port == local_port)?;
            Some(entries.remove(idx))
        })
    };
    if removed.is_none() {
        return Ok(StopPortForwardResult { stopped: false });
    }
    let entry = removed.unwrap();

    let host = resolve_ssh_host(registry, &runtime_name)?;
    let control_dir = crate::remote::transport::ssh_control_dir();
    let mut cmd = build_cancel_command(
        &host,
        entry.local_port,
        entry.remote_port,
        control_dir.as_deref(),
    );
    let output = cmd
        .output()
        .with_context(|| format!("spawn `ssh -O cancel` for `{runtime_name}`"))?;
    if !output.status.success() {
        // The master may have already torn down the forward on
        // its side (e.g. the runtime disconnected). Treat that
        // as success from the desktop's perspective — the entry
        // is gone from our state either way, and bubbling the
        // ssh error would just confuse the operator clicking
        // "Stop".
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        tracing::warn!(
            runtime = %runtime_name,
            local = local_port,
            remote = entry.remote_port,
            ssh_stderr = %stderr,
            "remote-runner: ssh -O cancel returned non-zero; treating as soft success"
        );
    }
    persist_after_mutation(manager);
    Ok(StopPortForwardResult { stopped: true })
}

// ── list_remote_port_forwards ───────────────────────────────────────

#[tauri::command]
pub async fn list_remote_port_forwards(
    manager: tauri::State<'_, Arc<RemotePortForwardManager>>,
    runtime_name: Option<String>,
) -> CmdResult<Vec<PortForwardEntry>> {
    let manager = Arc::clone(&manager);
    run_blocking(move || -> Result<Vec<PortForwardEntry>> {
        match runtime_name {
            Some(name) if !name.trim().is_empty() => Ok(manager.for_runtime(&name)),
            _ => Ok(manager.snapshot()),
        }
    })
    .await
}

// ── boot-time restore ───────────────────────────────────────────────

/// Replay every persisted forward whose runtime is still
/// registered as SSH. Called from app `setup` after the
/// registry restore completes. Failures per-entry log + skip;
/// a single bad entry never blocks the rest.
pub fn restore_persisted_forwards(
    registry: &Arc<RuntimeRegistry>,
    manager: &Arc<RemotePortForwardManager>,
    data_dir: &Path,
) {
    let persisted = load_persisted(data_dir);
    if persisted.forwards.is_empty() {
        return;
    }
    let mut restored_any = false;
    for entry in persisted.forwards {
        let label = entry.label.clone();
        match start_remote_port_forward_inner(
            registry,
            manager,
            entry.runtime_name.clone(),
            entry.local_port,
            entry.remote_port,
            label,
        ) {
            Ok(_) => restored_any = true,
            Err(err) => {
                tracing::warn!(
                    runtime = %entry.runtime_name,
                    local = entry.local_port,
                    remote = entry.remote_port,
                    error = %format!("{err:#}"),
                    "remote-runner: failed to restore port forward; dropping"
                );
            }
        }
    }
    if restored_any {
        // Rewrite the persisted file with whatever survived the
        // restore so a subsequent boot doesn't keep retrying
        // entries that no longer apply (runtime gone, removed,
        // command-shaped now).
        let snapshot = PersistedPortForwards {
            forwards: manager.snapshot(),
        };
        save_persisted(data_dir, &snapshot);
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn empty_manager() -> Arc<RemotePortForwardManager> {
        Arc::new(RemotePortForwardManager::new())
    }

    fn empty_registry() -> Arc<RuntimeRegistry> {
        Arc::new(RuntimeRegistry::new())
    }

    fn registry_with_command_runtime() -> Arc<RuntimeRegistry> {
        let registry = Arc::new(RuntimeRegistry::new());
        // The actual runtime under the hood doesn't matter for
        // these tests — we just need a registered config of the
        // Command variant. Borrow a stub from the loopback tests
        // would require a richer test harness; instead we drive
        // the resolver through the registry's snapshot_configs
        // path by registering with a config directly.
        // Any Arc<dyn RemoteRuntime> works — we never call into
        // it from these tests; the resolver only reads the
        // registered config (the second argument to register).
        let stub: Arc<dyn crate::remote::RemoteRuntime> =
            Arc::new(crate::remote::LocalRuntime::new());
        registry
            .register(
                "tsh.dev",
                stub,
                Some(RuntimeConnectionConfig::Command {
                    argv: vec!["tsh".into(), "ssh".into(), "dev".into()],
                }),
            )
            .unwrap();
        registry
    }

    fn registry_with_ssh_runtime(name: &str, host: &str) -> Arc<RuntimeRegistry> {
        let registry = Arc::new(RuntimeRegistry::new());
        // Any Arc<dyn RemoteRuntime> works — we never call into
        // it from these tests; the resolver only reads the
        // registered config (the second argument to register).
        let stub: Arc<dyn crate::remote::RemoteRuntime> =
            Arc::new(crate::remote::LocalRuntime::new());
        registry
            .register(
                name,
                stub,
                Some(RuntimeConnectionConfig::Ssh {
                    host: host.to_string(),
                    remote_binary: "helmor-server".into(),
                }),
            )
            .unwrap();
        registry
    }

    // ── input validation ──────────────────────────────────────────

    #[test]
    fn start_rejects_zero_ports() {
        let registry = empty_registry();
        let manager = empty_manager();
        let err =
            start_remote_port_forward_inner(&registry, &manager, "dev.box".into(), 0, 3000, None)
                .unwrap_err();
        assert!(format!("{err:#}").contains("local port must not be zero"));

        let err =
            start_remote_port_forward_inner(&registry, &manager, "dev.box".into(), 5173, 0, None)
                .unwrap_err();
        assert!(format!("{err:#}").contains("remote port must not be zero"));
    }

    #[test]
    fn start_rejects_empty_runtime_name() {
        let registry = empty_registry();
        let manager = empty_manager();
        let err = start_remote_port_forward_inner(&registry, &manager, "".into(), 5173, 3000, None)
            .unwrap_err();
        assert!(format!("{err:#}").contains("runtime name must not be empty"));
    }

    #[test]
    fn start_rejects_local_runtime_by_name() {
        let registry = empty_registry();
        let manager = empty_manager();
        let err = start_remote_port_forward_inner(
            &registry,
            &manager,
            LOCAL_RUNTIME_NAME.into(),
            5173,
            3000,
            None,
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("only available on registered remote runtimes"));
    }

    #[test]
    fn start_rejects_command_transport_with_legible_redirect_message() {
        // Command transports can't piggyback on ControlMaster
        // (they don't have one). The error must point the operator
        // at the right tool rather than just bailing opaquely.
        let registry = registry_with_command_runtime();
        let manager = empty_manager();
        let err = start_remote_port_forward_inner(
            &registry,
            &manager,
            "tsh.dev".into(),
            5173,
            3000,
            None,
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("only supported on SSH"),
            "expected SSH-only message: {msg}"
        );
        assert!(
            msg.contains("tailscale ssh -L") || msg.contains("kubectl port-forward"),
            "expected wrapper-tool hint: {msg}"
        );
    }

    #[test]
    fn start_rejects_unregistered_runtime() {
        let registry = empty_registry();
        let manager = empty_manager();
        let err = start_remote_port_forward_inner(
            &registry,
            &manager,
            "ghost.box".into(),
            5173,
            3000,
            None,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("not registered"));
    }

    #[test]
    fn start_rejects_duplicate_local_port_on_same_runtime() {
        // Pre-seed the manager state to simulate a previous
        // successful start; the second call's duplicate check
        // must fire before we try to spawn ssh.
        let registry = registry_with_ssh_runtime("dev.box", "dev.box");
        let manager = empty_manager();
        manager.forwards.lock().unwrap().insert(
            "dev.box".into(),
            vec![PortForwardEntry {
                runtime_name: "dev.box".into(),
                local_port: 5173,
                remote_port: 3000,
                label: None,
                started_at_ms: 0,
            }],
        );
        let err = start_remote_port_forward_inner(
            &registry,
            &manager,
            "dev.box".into(),
            5173,
            7000,
            None,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("already forwarded"));
    }

    #[test]
    fn stop_returns_stopped_false_for_unknown_runtime_or_port() {
        let registry = empty_registry();
        let manager = empty_manager();
        let result =
            stop_remote_port_forward_inner(&registry, &manager, "never-registered".into(), 5173)
                .unwrap();
        assert!(!result.stopped);
    }

    #[test]
    fn stop_rejects_zero_port() {
        let registry = empty_registry();
        let manager = empty_manager();
        let err =
            stop_remote_port_forward_inner(&registry, &manager, "dev.box".into(), 0).unwrap_err();
        assert!(format!("{err:#}").contains("local port must not be zero"));
    }

    // ── manager state lifecycle ───────────────────────────────────

    #[test]
    fn manager_snapshot_orders_by_runtime_then_local_port() {
        let manager = empty_manager();
        let entries = [
            ("zeta.box", 9000_u16),
            ("alpha.box", 7000_u16),
            ("alpha.box", 3000_u16),
            ("zeta.box", 4000_u16),
        ];
        for (rt, port) in entries {
            manager
                .forwards
                .lock()
                .unwrap()
                .entry(rt.into())
                .or_default()
                .push(PortForwardEntry {
                    runtime_name: rt.into(),
                    local_port: port,
                    remote_port: 1000,
                    label: None,
                    started_at_ms: 0,
                });
        }
        let snapshot = manager.snapshot();
        let pairs: Vec<(String, u16)> = snapshot
            .iter()
            .map(|e| (e.runtime_name.clone(), e.local_port))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("alpha.box".to_string(), 3000),
                ("alpha.box".into(), 7000),
                ("zeta.box".into(), 4000),
                ("zeta.box".into(), 9000),
            ]
        );
    }

    #[test]
    fn manager_for_runtime_returns_only_matching_entries() {
        let manager = empty_manager();
        manager.forwards.lock().unwrap().insert(
            "alpha".into(),
            vec![PortForwardEntry {
                runtime_name: "alpha".into(),
                local_port: 3000,
                remote_port: 3000,
                label: None,
                started_at_ms: 0,
            }],
        );
        manager.forwards.lock().unwrap().insert(
            "beta".into(),
            vec![PortForwardEntry {
                runtime_name: "beta".into(),
                local_port: 4000,
                remote_port: 4000,
                label: None,
                started_at_ms: 0,
            }],
        );
        let alpha = manager.for_runtime("alpha");
        assert_eq!(alpha.len(), 1);
        assert_eq!(alpha[0].local_port, 3000);
        assert!(manager.for_runtime("ghost").is_empty());
    }

    // ── command builders (pure functions) ─────────────────────────

    #[test]
    fn build_forward_command_emits_dash_o_forward_with_explicit_loopback_bind() {
        let dir = std::path::Path::new("/tmp/ssh-cm-test");
        let cmd = build_forward_command("dev.box", 5173, 3000, Some(dir));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        // BatchMode + ControlMaster wiring + ControlPath
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        assert!(args.windows(2).any(|w| w == ["-o", "ControlMaster=auto"]));
        assert!(args
            .iter()
            .any(|a| a == &format!("ControlPath={}/%C", dir.display())));
        // The forward request itself.
        assert_eq!(
            args.windows(2)
                .find(|w| w[0] == "-O")
                .map(|w| w[1].as_str()),
            Some("forward")
        );
        assert_eq!(
            args.windows(2).find(|w| w[0] == "-L").map(|w| w[1].clone()),
            Some("127.0.0.1:5173:127.0.0.1:3000".to_string())
        );
        // Host as the final arg.
        assert_eq!(args.last().map(String::as_str), Some("dev.box"));
    }

    #[test]
    fn build_cancel_command_inverts_forward_arg() {
        let dir = std::path::Path::new("/tmp/ssh-cm-test");
        let cmd = build_cancel_command("dev.box", 5173, 3000, Some(dir));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args.windows(2)
                .find(|w| w[0] == "-O")
                .map(|w| w[1].as_str()),
            Some("cancel")
        );
        assert_eq!(
            args.windows(2).find(|w| w[0] == "-L").map(|w| w[1].clone()),
            Some("127.0.0.1:5173:127.0.0.1:3000".to_string())
        );
    }

    #[test]
    fn build_forward_command_omits_controlmaster_when_dir_missing() {
        // No control dir = the resolver couldn't write to the
        // data dir (sandbox, no $HOME). The command should still
        // be runnable, just without -O forward picking up a
        // master. In practice this errors out at runtime
        // ("No ControlMaster connection found") — surfaced as a
        // legible ssh stderr to the operator. Test asserts the
        // shape stays opt-in.
        let cmd = build_forward_command("dev.box", 5173, 3000, None);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(!args.iter().any(|a| a.starts_with("ControlPath=")));
        assert_eq!(
            args.windows(2)
                .find(|w| w[0] == "-O")
                .map(|w| w[1].as_str()),
            Some("forward")
        );
    }

    // ── persistence ───────────────────────────────────────────────

    #[test]
    fn load_persisted_missing_file_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot = load_persisted(dir.path());
        assert!(snapshot.forwards.is_empty());
    }

    #[test]
    fn load_persisted_malformed_file_returns_empty_and_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(persist_file_path(dir.path()), "not valid json").unwrap();
        let snapshot = load_persisted(dir.path());
        assert!(snapshot.forwards.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_entries() {
        let dir = tempfile::tempdir().unwrap();
        let to_save = PersistedPortForwards {
            forwards: vec![
                PortForwardEntry {
                    runtime_name: "dev.box".into(),
                    local_port: 5173,
                    remote_port: 3000,
                    label: Some("Vite".into()),
                    started_at_ms: 1_700_000_000_000,
                },
                PortForwardEntry {
                    runtime_name: "staging.box".into(),
                    local_port: 8080,
                    remote_port: 8080,
                    label: None,
                    started_at_ms: 0,
                },
            ],
        };
        save_persisted(dir.path(), &to_save);
        let restored = load_persisted(dir.path());
        assert_eq!(restored.forwards.len(), 2);
        assert_eq!(restored.forwards[0].runtime_name, "dev.box");
        assert_eq!(restored.forwards[0].label.as_deref(), Some("Vite"));
        assert_eq!(restored.forwards[1].local_port, 8080);
    }

    #[test]
    fn save_is_atomic_via_tmp_rename() {
        // Sanity: writing twice + reading should always see the
        // most-recent payload. The rename should never leave the
        // file in a half-written state.
        let dir = tempfile::tempdir().unwrap();
        save_persisted(
            dir.path(),
            &PersistedPortForwards {
                forwards: vec![PortForwardEntry {
                    runtime_name: "a".into(),
                    local_port: 1000,
                    remote_port: 1000,
                    label: None,
                    started_at_ms: 0,
                }],
            },
        );
        save_persisted(
            dir.path(),
            &PersistedPortForwards {
                forwards: vec![PortForwardEntry {
                    runtime_name: "b".into(),
                    local_port: 2000,
                    remote_port: 2000,
                    label: None,
                    started_at_ms: 0,
                }],
            },
        );
        let restored = load_persisted(dir.path());
        assert_eq!(restored.forwards.len(), 1);
        assert_eq!(restored.forwards[0].runtime_name, "b");
    }

    #[test]
    fn entry_round_trips_through_camel_case_serde() {
        let entry = PortForwardEntry {
            runtime_name: "dev.box".into(),
            local_port: 5173,
            remote_port: 3000,
            label: Some("Vite".into()),
            started_at_ms: 1_700_000_000_000,
        };
        let wire = serde_json::to_string(&entry).unwrap();
        assert!(wire.contains("\"runtimeName\":\"dev.box\""));
        assert!(wire.contains("\"localPort\":5173"));
        assert!(wire.contains("\"remotePort\":3000"));
        assert!(wire.contains("\"startedAtMs\":1700000000000"));
        let round: PortForwardEntry = serde_json::from_str(&wire).unwrap();
        assert_eq!(round, entry);
    }

    #[test]
    fn entry_omits_optional_label_when_absent() {
        let entry = PortForwardEntry {
            runtime_name: "dev.box".into(),
            local_port: 5173,
            remote_port: 3000,
            label: None,
            started_at_ms: 0,
        };
        let wire = serde_json::to_string(&entry).unwrap();
        assert!(!wire.contains("\"label\""), "label must elide: {wire}");
    }
}
