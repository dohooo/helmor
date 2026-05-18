//! Tauri command surface for the remote-runner trait seam.
//!
//! Every runtime-bound command takes an optional `runtimeName`. `None`
//! and `"local"` route through the in-process [`crate::remote::LocalRuntime`];
//! anything else does a [`crate::remote::RuntimeRegistry`] lookup. The
//! registry itself lives as a `tauri::State` so a single instance is
//! shared across the whole app.
//!
//! Lifecycle commands (`connect_remote_runtime` /
//! `disconnect_remote_runtime` / `list_remote_runtimes`) mutate the
//! registry. The actual `ssh` spawn + initialize handshake runs on the
//! blocking thread pool because `RpcClient::connect_ssh` is sync.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use tauri::ipc::Channel;

use crate::remote::{
    methods::{
        TerminalAttachParams, TerminalAttachResult, TerminalCloseParams, TerminalEventNotification,
        TerminalListParams, TerminalListResult, TerminalOpenParams, TerminalOpenResult,
        TerminalResizeParams, TerminalWriteParams, TerminalWriteResult, WorkspaceBranchInfoResult,
        WorkspaceChangesParams, WorkspaceChangesResult, WorkspaceFileTreeParams,
        WorkspaceFileTreeResult, WorkspaceMutateFileAction, WorkspaceMutateFileParams,
        WorkspaceMutateFileResult, WorkspaceReadFileAtRefParams, WorkspaceReadFileAtRefResult,
        WorkspaceReadFileParams, WorkspaceStatFileParams, WorkspaceStatusResult,
    },
    persistence, CommandTransport, NotificationSubscription, OwnedTerminals, RemoteRuntime,
    RemoteSshRuntime, RemoteTransport, RpcClient, RuntimeConnectionConfig, RuntimeHealth,
    RuntimeRegistry, RuntimeState, WorkspaceRuntimeBinding, WorkspaceRuntimeBindings,
    LOCAL_RUNTIME_NAME,
};
use crate::workspace::files::{EditorFileReadResponse, EditorFileStatResponse};

use super::common::{run_blocking, CmdResult};

/// Subscriptions held alive while a terminal is open. Keyed by
/// `terminal_id` (client-chosen, unique per remote). `Drop` on each
/// `NotificationSubscription` unregisters the per-terminal callback
/// on the underlying [`RpcClient`].
///
/// Stored as a `tauri::State` so the open/close commands can land
/// the subscription somewhere it survives the function scope.
#[derive(Default)]
pub struct RemoteTerminalSubscriptions {
    inner: std::sync::Mutex<HashMap<String, NotificationSubscription>>,
}

impl RemoteTerminalSubscriptions {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, terminal_id: String, subscription: NotificationSubscription) {
        self.inner
            .lock()
            .expect("remote terminal subscriptions mutex poisoned")
            .insert(terminal_id, subscription);
    }

    fn remove(&self, terminal_id: &str) {
        self.inner
            .lock()
            .expect("remote terminal subscriptions mutex poisoned")
            .remove(terminal_id);
    }
}

/// Probe a runtime's health. Cheap + side-effect-free — safe to poll
/// from the frontend on a focus tick or to surface in a connection
/// chip.
#[tauri::command]
pub fn get_runtime_health(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    runtime_name: Option<String>,
) -> CmdResult<RuntimeHealth> {
    let runtime = registry.lookup(runtime_name.as_deref())?;
    Ok(runtime.runtime_health()?)
}

/// Project the workspace's `git status --porcelain` output through
/// the runtime seam.
///
/// Runtime resolution order:
///   1. `runtime_name` — explicit override; the caller's "use this
///      runtime, ignore any binding" knob.
///   2. `workspace_id` — look up the persisted binding for the
///      workspace. Missing binding falls through to local.
///   3. Neither → local.
///
/// `workspace_dir` is interpreted on the *runtime's* filesystem —
/// for a remote runtime that's the server's filesystem, not the
/// desktop's.
///
/// Runs on a blocking thread because the local impl shells out to
/// `git` and the remote impl blocks on a JSON-RPC round-trip.
#[tauri::command]
pub async fn get_workspace_status(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceStatusResult> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        let path = PathBuf::from(workspace_dir);
        let resolved = resolve_runtime_for_call(
            &registry,
            &bindings,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )?;
        resolved.workspace_status(&path)
    })
    .await
}

/// Read-only "where am I?" probe for a workspace — current branch,
/// head commit, and upstream tracking ref. Same resolver as
/// [`get_workspace_status`] so the binding precedence rule is
/// shared.
#[tauri::command]
pub async fn get_workspace_branch_info(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceBranchInfoResult> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        let path = PathBuf::from(workspace_dir);
        let resolved = resolve_runtime_for_call(
            &registry,
            &bindings,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )?;
        resolved.workspace_branch_info(&path)
    })
    .await
}

// ── workspace inspector ops (phase 20c) ─────────────────────────────
//
// Every command below routes through `resolve_runtime_for_call` so the
// same `workspace_id` → binding precedence rule that `get_workspace_status`
// established also applies to file tree / changes / read / stat /
// mutate. Frontend keeps passing the binding triple verbatim.
//
// Per-command `*_inner` helpers exist because the Tauri command body
// can't be invoked from a unit test directly — `tauri::State` can't be
// constructed outside the IPC dispatcher — so we factor the body into
// a free function that takes plain `&Arc<...>` and exercise it from
// tests. The `#[tauri::command]` wrapper is then a four-liner that
// `Arc::clone`s the state and hops onto the blocking pool.

/// Recursive file listing for a workspace, routed through the seam.
/// Hot caller on workspace switch — pages the inspector's file tree.
#[tauri::command]
pub async fn get_workspace_file_tree(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceFileTreeResult> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        get_workspace_file_tree_inner(
            &registry,
            &bindings,
            workspace_dir,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )
    })
    .await
}

fn get_workspace_file_tree_inner(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_dir: String,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> Result<WorkspaceFileTreeResult> {
    let resolved = resolve_runtime_for_call(registry, bindings, workspace_id, runtime_name)?;
    resolved.workspace_file_tree(WorkspaceFileTreeParams { workspace_dir })
}

/// `git status`-aware projection plus optional per-file diff bodies.
/// `include_content=false` is the cheap mode the inspector sidebar
/// polls; `true` is the diff-panel mode that prefetches the per-file
/// content for the diff viewer.
#[tauri::command]
pub async fn get_workspace_changes(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    include_content: bool,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceChangesResult> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        get_workspace_changes_inner(
            &registry,
            &bindings,
            workspace_dir,
            include_content,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )
    })
    .await
}

fn get_workspace_changes_inner(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_dir: String,
    include_content: bool,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> Result<WorkspaceChangesResult> {
    let resolved = resolve_runtime_for_call(registry, bindings, workspace_id, runtime_name)?;
    resolved.workspace_changes(WorkspaceChangesParams {
        workspace_dir,
        include_content,
    })
}

/// Read a single file's bytes + mtime. Used by both the editor surface
/// and the diff viewer's "working tree" side.
#[tauri::command]
pub async fn read_workspace_file(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    relative_path: String,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<EditorFileReadResponse> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        read_workspace_file_inner(
            &registry,
            &bindings,
            workspace_dir,
            relative_path,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )
    })
    .await
}

fn read_workspace_file_inner(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_dir: String,
    relative_path: String,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> Result<EditorFileReadResponse> {
    let resolved = resolve_runtime_for_call(registry, bindings, workspace_id, runtime_name)?;
    resolved.workspace_read_file(WorkspaceReadFileParams {
        workspace_dir,
        relative_path,
    })
}

/// `git show <ref>:<path>` body. `None` content means "the path
/// didn't exist at that ref" — distinct from an empty file.
#[tauri::command]
pub async fn read_workspace_file_at_ref(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    relative_path: String,
    git_ref: String,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceReadFileAtRefResult> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        read_workspace_file_at_ref_inner(
            &registry,
            &bindings,
            workspace_dir,
            relative_path,
            git_ref,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )
    })
    .await
}

fn read_workspace_file_at_ref_inner(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_dir: String,
    relative_path: String,
    git_ref: String,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> Result<WorkspaceReadFileAtRefResult> {
    let resolved = resolve_runtime_for_call(registry, bindings, workspace_id, runtime_name)?;
    resolved.workspace_read_file_at_ref(WorkspaceReadFileAtRefParams {
        workspace_dir,
        relative_path,
        git_ref,
    })
}

/// Stat probe. `exists=false` (rather than an error) for a missing
/// path so the inspector can render a "no longer exists" hint
/// without a red toast.
#[tauri::command]
pub async fn stat_workspace_file(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    relative_path: String,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<EditorFileStatResponse> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        stat_workspace_file_inner(
            &registry,
            &bindings,
            workspace_dir,
            relative_path,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )
    })
    .await
}

fn stat_workspace_file_inner(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_dir: String,
    relative_path: String,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> Result<EditorFileStatResponse> {
    let resolved = resolve_runtime_for_call(registry, bindings, workspace_id, runtime_name)?;
    resolved.workspace_stat_file(WorkspaceStatFileParams {
        workspace_dir,
        relative_path,
    })
}

/// All write-side ops in one command, discriminated by the `action`
/// tag (`write` | `discard` | `stage` | `unstage`). One IPC entry per
/// mutation kind would balloon the registered command list without
/// shrinking any individual handler.
#[tauri::command]
pub async fn mutate_workspace_file(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    relative_path: String,
    action: WorkspaceMutateFileAction,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceMutateFileResult> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        mutate_workspace_file_inner(
            &registry,
            &bindings,
            workspace_dir,
            relative_path,
            action,
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )
    })
    .await
}

fn mutate_workspace_file_inner(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_dir: String,
    relative_path: String,
    action: WorkspaceMutateFileAction,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> Result<WorkspaceMutateFileResult> {
    let resolved = resolve_runtime_for_call(registry, bindings, workspace_id, runtime_name)?;
    resolved.workspace_mutate_file(WorkspaceMutateFileParams {
        workspace_dir,
        relative_path,
        action,
    })
}

/// Pick the runtime the dispatch should land on. Phase 22b
/// precedence: explicit `runtime_name` > `workspaces.runtime_name`
/// column > JSON sidecar binding store > local runtime.
///
/// Workspace-id resolution consults the DB column first so a
/// recently-bound workspace doesn't have to wait for the sidecar
/// JSON to round-trip through `save_to_disk` before the resolver
/// sees the new value. A read error on the column (DB unavailable,
/// migration failed) silently falls through to the sidecar — the
/// resolver should never refuse to dispatch because the column
/// couldn't be read.
///
/// Factored out so tests can drive the resolution rule directly
/// without spinning up a Tauri command harness, and so future
/// commands (terminal, scripts, agents) can call the same logic
/// before they dispatch.
fn resolve_runtime_for_call(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> anyhow::Result<Arc<dyn RemoteRuntime>> {
    // Hot-cache the column lookup once per call so the rest of the
    // resolver is DB-free and can be unit-tested via
    // `resolve_runtime_for_call_with_column`.
    let column_binding = workspace_id.filter(|id| !id.is_empty()).and_then(|id| {
        crate::models::workspaces::load_workspace_runtime_name(id)
            .ok()
            .flatten()
    });
    resolve_runtime_for_call_with_column(
        registry,
        bindings,
        workspace_id,
        runtime_name,
        column_binding.as_deref(),
    )
}

/// Pure-logic variant of [`resolve_runtime_for_call`] that takes
/// the column-resolved binding as an argument rather than reading
/// the DB. Tests use this so they can drive every precedence branch
/// (column hit, column miss + sidecar hit, both miss) without
/// initializing a pool.
fn resolve_runtime_for_call_with_column(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
    column_binding: Option<&str>,
) -> anyhow::Result<Arc<dyn RemoteRuntime>> {
    if let Some(name) = runtime_name.filter(|n| !n.is_empty()) {
        return registry.lookup(Some(name));
    }
    if let Some(id) = workspace_id.filter(|id| !id.is_empty()) {
        // Phase 22b precedence: DB column wins over sidecar. Phase
        // 22a's backfill ensured the column reflects every existing
        // sidecar binding; subsequent writes go through both surfaces
        // (see `set_workspace_runtime_binding`) so the two stay in
        // sync until we can sunset the sidecar entirely.
        let bound: Option<String> = column_binding
            .map(|s| s.to_string())
            .or_else(|| bindings.lookup(id));
        if let Some(bound) = bound {
            // The binding may point at a runtime that disconnected
            // after the pin was created. Try the lookup; if the
            // runtime's not currently registered, fall back to local
            // with a log line — same contract as the dev panel's
            // "isn't currently registered" warning.
            match registry.lookup(Some(&bound)) {
                Ok(rt) => return Ok(rt),
                Err(_) => {
                    tracing::warn!(
                        workspace_id = %id,
                        bound_runtime = %bound,
                        "remote-runner: bound runtime not registered; falling back to local"
                    );
                }
            }
        }
    }
    registry.lookup(None)
}

/// Spawn `ssh <host> <remote_binary>`, run the JSON-RPC handshake,
/// and register the resulting runtime under `name`. Returns the
/// cached health snapshot so the caller doesn't have to round-trip
/// for a "connected" indicator.
///
/// Fails fast if the name is taken, reserved (`"local"`), or if the
/// SSH spawn / handshake errored. Connection setup runs on the
/// blocking pool — `ssh` can take seconds on a cold connection.
#[tauri::command]
pub async fn connect_remote_runtime(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
    host: String,
    remote_binary: String,
) -> CmdResult<RuntimeHealth> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        // Capture the operator's *requested* binary in the persisted
        // config — that's what they should see in the dev panel — even
        // when the actual connect ends up using an auto-installed
        // path. Re-running install on the next boot is cheap and
        // idempotent.
        let config = RuntimeConnectionConfig::Ssh {
            host: host.clone(),
            remote_binary: remote_binary.clone(),
        };
        // Auto-install runs on the blocking pool because both ssh
        // probe + scp upload are sync subprocesses. A locally-built
        // helmor-server binary is required to install; if we can't
        // find one we surface the same legible error
        // `connect_local_runtime` does.
        let local_binary = crate::remote::install::resolve_local_helmor_server_path()?;
        let resolved_binary = crate::remote::install::ensure_remote_helmor_server(
            &crate::remote::install::ProcessSshRunner,
            &host,
            &remote_binary,
            &local_binary,
        )?;
        let runtime = RemoteSshRuntime::connect_ssh(&host, &resolved_binary)?;
        let health = runtime.runtime_health()?;
        registry.register(name, Arc::new(runtime), Some(config))?;
        persist_registry(&registry);
        Ok(health)
    })
    .await
}

/// Remove a named runtime from the registry. The runtime's `Drop`
/// kills + reaps the SSH child. Refuses to disconnect `"local"`.
#[tauri::command]
pub fn disconnect_remote_runtime(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
) -> CmdResult<()> {
    registry.unregister(&name)?;
    persist_registry(&registry);
    Ok(())
}

/// Re-establish a connection using the entry's previously-persisted
/// config. Used by the Reconnect button on a tombstoned entry (one
/// whose initial restore failed at boot) and by manual recovery from
/// a Disconnected state in the dev panel.
///
/// Returns the fresh `RuntimeHealth` on success, same as the
/// `connect_*` commands. Errors if the entry isn't known to the
/// registry or doesn't carry a persisted config.
#[tauri::command]
pub async fn reconnect_remote_runtime(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
) -> CmdResult<RuntimeHealth> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        let config = registry.config_for(&name).ok_or_else(|| {
            anyhow::anyhow!(
                "runtime `{name}` has no persisted config; remove it and re-add via Connect"
            )
        })?;
        // Drop the stale entry (tombstone or live) before reconnecting
        // so `register` doesn't reject the duplicate name. The Arc held
        // by other callers stays valid until they release — same
        // contract as `disconnect_remote_runtime`.
        let _ = registry.unregister(&name);
        let runtime = persistence::connect_from_config(&config)?;
        let health = runtime.runtime_health()?;
        registry.register(name, runtime, Some(config))?;
        persist_registry(&registry);
        Ok(health)
    })
    .await
}

/// Phase 23d: push an SDK API key (or clear it) into a remote
/// runtime's secrets store. The daemon persists to
/// `$HOME/.helmor/server/secrets.json` (mode 0600) and hot-pushes
/// to the live sidecar via `updateConfig` — keys never persist on
/// the desktop side.
///
/// `provider` is the SDK identifier the sidecar uses internally
/// (`"cursor"` today; future providers reuse the same RPC).
/// `api_key = None` clears the stored key (with the matching live
/// push so the next provider call reverts to unauthenticated).
#[tauri::command]
pub async fn set_runtime_agent_auth(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
    provider: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> CmdResult<()> {
    if name.trim().is_empty() {
        return Err(anyhow::anyhow!("runtime name must not be empty").into());
    }
    if provider.trim().is_empty() {
        return Err(anyhow::anyhow!("provider must not be empty").into());
    }
    // Refuse to ship secrets to the built-in local runtime — that
    // entry doesn't have a remote sidecar to push them to, and the
    // desktop already manages its own Cursor key through
    // `app.cursor_provider`. Surface the misuse rather than
    // silently no-op (the trait's `agent_set_auth` default would
    // also bail, but with a less-helpful "only on connected
    // remote" message).
    if name == crate::remote::LOCAL_RUNTIME_NAME {
        return Err(anyhow::anyhow!(
            "agent.setAuth is only available on registered remote runtimes (got `{name}`)"
        )
        .into());
    }
    let runtime = registry.lookup(Some(&name))?;
    run_blocking(move || -> anyhow::Result<()> {
        let _ = runtime.agent_set_auth(crate::remote::AgentSetAuthParams {
            provider,
            api_key,
            base_url,
        })?;
        Ok(())
    })
    .await
}

/// Snapshot the registry's current configs and write them to
/// `<data_dir>/remote_runtimes.json`. Best-effort — failures log
/// without rolling back the mutation that triggered the save.
fn persist_registry(registry: &Arc<RuntimeRegistry>) {
    let data_dir = match crate::data_dir::data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            tracing::warn!(
                error = %format!("{err:#}"),
                "remote-runner: cannot resolve data dir; skipping persist"
            );
            return;
        }
    };
    let snapshot = persistence::snapshot_from_registry(registry);
    persistence::save(&data_dir, &snapshot);
}

/// Lifecycle list shown to the UI. Always starts with `"local"`,
/// followed by registered remotes sorted alphabetically.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEntry {
    pub name: String,
    /// `true` for the reserved local entry. The UI uses this to
    /// gate "disconnect" buttons — you can't disconnect the local
    /// runtime.
    pub is_local: bool,
    /// Latest known connection state. The local entry is always
    /// Connected; remote entries reflect the liveness loop's most
    /// recent decision.
    pub state: RuntimeState,
    /// Connection config the entry was last registered with, if
    /// any. `None` for the local runtime (no config) and for
    /// entries registered through the registry API directly (tests,
    /// ad-hoc tools). The UI surfaces this in the chip tooltip so
    /// the user can tell "ssh: dev.box helmor-server" from
    /// "local: /Users/me/target/debug/helmor-server" at a glance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<RuntimeConnectionConfig>,
}

/// Spawn the `helmor-server` binary as a local child process (no SSH
/// in the loop) and register the resulting runtime under `name`.
/// Smoke-test affordance for the dev build — lets the running app
/// exercise the full RPC vertical without needing an SSH-reachable
/// host. Production setups should use [`connect_remote_runtime`].
///
/// `binary_path` is optional — if omitted, falls back to
/// `$HELMOR_SERVER_PATH`, then to `<exe_dir>/helmor-server` next to
/// the running app binary (Cargo's standard layout in dev).
#[tauri::command]
pub async fn connect_local_runtime(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
    binary_path: Option<String>,
) -> CmdResult<RuntimeHealth> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        let config = RuntimeConnectionConfig::Local {
            binary_path: binary_path.clone(),
        };
        let path = match binary_path {
            Some(p) => PathBuf::from(p),
            None => resolve_local_helmor_server_path()?,
        };
        let label = path.display().to_string();
        let cmd = std::process::Command::new(&path);
        let client = RpcClient::connect_command(cmd, label.clone())?;
        let runtime = RemoteSshRuntime::new(client, label);
        let health = runtime.runtime_health()?;
        registry.register(name, Arc::new(runtime), Some(config))?;
        persist_registry(&registry);
        Ok(health)
    })
    .await
}

/// Connect to a `helmor-server` reachable via an arbitrary `argv`
/// list. The argv is handed straight to `Command`; no shell tokenises
/// it, so quoting hazards don't apply. Used for transports like
/// Teleport, Tailscale SSH, or `kubectl exec` where the wrapper isn't
/// `ssh(1)` itself.
///
/// Auto-install is out of scope: the operator must have
/// `helmor-server` pre-installed on the remote side and pass an argv
/// that invokes it with `--proxy`. Mirrors the contract of
/// [`connect_remote_runtime`] otherwise — same registry, same persist
/// path, same idempotent reconnect on restart.
#[tauri::command]
pub async fn connect_command_runtime(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
    argv: Vec<String>,
) -> CmdResult<RuntimeHealth> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        if argv.is_empty() {
            bail!("argv must not be empty");
        }
        let config = RuntimeConnectionConfig::Command { argv: argv.clone() };
        let transport: Arc<dyn RemoteTransport> = Arc::new(CommandTransport::new(argv.clone()));
        let peer_label = CommandTransport::new(argv).peer_label();
        let client = RpcClient::connect_with_transport(transport)?;
        let runtime = RemoteSshRuntime::new(client, peer_label);
        let health = runtime.runtime_health()?;
        registry.register(name, Arc::new(runtime), Some(config))?;
        persist_registry(&registry);
        Ok(health)
    })
    .await
}

/// Locate a runnable `helmor-server` binary. Resolution order:
/// 1. `HELMOR_SERVER_PATH` env override (any path that exists).
/// 2. `<exe_dir>/helmor-server[.exe]` next to the running app —
///    matches Cargo's `target/debug/` layout in dev.
///
/// This is intentionally narrow: the spike doesn't bundle
/// `helmor-server` into release builds, so the only "real" use is
/// dev-mode smoke testing. Returns a clear error rather than guessing
/// to keep failures legible.
fn resolve_local_helmor_server_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("HELMOR_SERVER_PATH") {
        let path = PathBuf::from(&p);
        if path.is_file() {
            return Ok(path);
        }
        bail!(
            "HELMOR_SERVER_PATH points to `{p}` which is not a file. \
             Unset the var or set it to the built helmor-server binary."
        );
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
    Err(anyhow::anyhow!(
        "helmor-server binary not found next to the running app. \
         Build it with `cargo build --bin helmor-server` or set HELMOR_SERVER_PATH."
    ))
    .context("connect_local_runtime: cannot resolve binary")
}

/// Surface the host aliases the user has named in `~/.ssh/config`.
/// Used by the dev panel's SSH connect form to populate a `<datalist>`
/// type-ahead. Empty list is fine — that's just "no suggestions",
/// the operator can still type a host they haven't aliased.
#[tauri::command]
pub fn list_ssh_hosts() -> CmdResult<Vec<String>> {
    Ok(crate::remote::ssh_config::list_user_ssh_hosts())
}

#[tauri::command]
pub fn list_remote_runtimes(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
) -> CmdResult<Vec<RuntimeEntry>> {
    Ok(registry
        .names()
        .into_iter()
        .map(|name| {
            let is_local = name == LOCAL_RUNTIME_NAME;
            // `state` returns None only for unknown names; the names
            // came from the same registry snapshot above so a None
            // here would mean the entry got unregistered between the
            // two reads. Fall back to Connected — the UI invalidates
            // again on the next mutation anyway.
            let state = registry.state(&name).unwrap_or(RuntimeState::Connected);
            let config = if is_local {
                None
            } else {
                registry.config_for(&name)
            };
            RuntimeEntry {
                name,
                is_local,
                state,
                config,
            }
        })
        .collect())
}

// ── per-workspace runtime bindings ───────────────────────────────

/// Pin a workspace to a runtime by name. Persisted across restarts.
/// The runtime doesn't have to exist at pin time — `lookup` falls
/// back to local when a bound runtime isn't currently registered.
/// Empty inputs are rejected so the persisted file can't grow junk
/// rows.
#[tauri::command]
pub fn set_workspace_runtime_binding(
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_id: String,
    runtime_name: String,
) -> CmdResult<()> {
    if workspace_id.trim().is_empty() {
        return Err(anyhow::anyhow!("workspace id must not be empty").into());
    }
    if runtime_name.trim().is_empty() {
        return Err(anyhow::anyhow!("runtime name must not be empty").into());
    }
    bindings.set(workspace_id.clone(), runtime_name.clone());
    persist_bindings(&bindings);
    // Phase 22b dual-write: keep the column in sync with the sidecar
    // so the resolver's column-first lookup sees the new binding
    // immediately. A failure here logs + continues — the sidecar is
    // still authoritative and the next boot's backfill will catch up.
    if let Err(err) =
        crate::models::workspaces::update_workspace_runtime_name(&workspace_id, Some(&runtime_name))
    {
        tracing::warn!(
            workspace_id = %workspace_id,
            runtime_name = %runtime_name,
            error = %format!("{err:#}"),
            "remote-runner: failed to mirror runtime binding into workspaces.runtime_name; sidecar JSON is still authoritative"
        );
    }
    Ok(())
}

/// Remove a binding. Idempotent — clearing an unbound workspace is
/// a no-op.
#[tauri::command]
pub fn clear_workspace_runtime_binding(
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_id: String,
) -> CmdResult<()> {
    bindings.clear(&workspace_id);
    persist_bindings(&bindings);
    // Phase 22b dual-write: clearing the binding means the column
    // goes back to NULL (= "use the local runtime").
    if let Err(err) = crate::models::workspaces::update_workspace_runtime_name(&workspace_id, None)
    {
        tracing::warn!(
            workspace_id = %workspace_id,
            error = %format!("{err:#}"),
            "remote-runner: failed to clear workspaces.runtime_name; sidecar JSON is still authoritative"
        );
    }
    Ok(())
}

/// Snapshot of every active binding. Sorted alphabetically by
/// workspace id for stable UI rendering.
#[tauri::command]
pub fn list_workspace_runtime_bindings(
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
) -> CmdResult<Vec<WorkspaceRuntimeBinding>> {
    Ok(bindings.list())
}

fn persist_bindings(bindings: &Arc<WorkspaceRuntimeBindings>) {
    let data_dir = match crate::data_dir::data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            tracing::warn!(
                error = %format!("{err:#}"),
                "remote-runner: cannot resolve data dir; skipping bindings persist"
            );
            return;
        }
    };
    bindings.save_to_disk(&data_dir);
}

// ── remote terminals ────────────────────────────────────────────

/// Open a PTY-backed terminal on a remote runtime. The server-side
/// PTY is registered under `terminalId` (caller-chosen); subsequent
/// `terminal.write` / `terminal.resize` / `terminal.close` calls
/// reference the same id.
///
/// The `channel` argument is a Tauri IPC `Channel<TerminalEventNotification>`
/// that fires for every server-pushed `terminal.event` matching
/// `terminalId`. The forwarding subscription is held on a process-
/// wide [`RemoteTerminalSubscriptions`] state and torn down by
/// `close_remote_terminal`.
///
/// Local runtimes don't go through this path — the existing
/// `spawn_terminal` / `write_terminal_stdin` commands handle local
/// PTYs. Calling this with `runtimeName = "local"` errors out at
/// the trait's default impl.
#[tauri::command]
// Tauri's command bindgen flattens this signature into the
// frontend JS surface; a "params" struct would route through serde
// and lose the per-arg invoke shape downstream code depends on.
#[allow(clippy::too_many_arguments)]
pub async fn open_remote_terminal(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    subscriptions: tauri::State<'_, Arc<RemoteTerminalSubscriptions>>,
    owned: tauri::State<'_, Arc<OwnedTerminals>>,
    runtime_name: String,
    terminal_id: String,
    workspace_dir: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEventNotification>,
) -> CmdResult<TerminalOpenResult> {
    let registry = Arc::clone(&registry);
    let subscriptions = Arc::clone(&subscriptions);
    let owned = Arc::clone(&owned);
    run_blocking(move || {
        let runtime = registry.lookup(Some(&runtime_name))?;

        // Subscribe BEFORE opening so the first PTY output chunk
        // (the shell's prompt) can't race ahead of the callback
        // registration. Filter on terminal_id so a single transport
        // can host multiple terminals without crossing wires.
        let term_id_for_filter = terminal_id.clone();
        let subscription = runtime
            .subscribe_terminal_events(Box::new(move |event| {
                if event.terminal_id == term_id_for_filter {
                    let _ = channel.send(event);
                }
            }))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "runtime `{runtime_name}` does not stream terminal events \
                     (only connected remote runtimes do)"
                )
            })?;

        let result = runtime.terminal_open(TerminalOpenParams {
            terminal_id: terminal_id.clone(),
            workspace_dir,
            shell,
            cols,
            rows,
        });
        match result {
            Ok(open) => {
                subscriptions.insert(terminal_id.clone(), subscription);
                // Mark the desktop as the owner so the Reattach UI
                // can surface this session on a future reconnect.
                // Persistence is best-effort; the in-memory state
                // is still correct even if the disk write fails.
                if owned.insert(&runtime_name, &terminal_id) {
                    persist_owned_terminals(&owned);
                }
                Ok(open)
            }
            Err(err) => {
                // Failed open → drop the subscription. The
                // NotificationSubscription's Drop unregisters the
                // callback automatically.
                drop(subscription);
                Err(err)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn write_remote_terminal(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    runtime_name: String,
    terminal_id: String,
    data: String,
) -> CmdResult<TerminalWriteResult> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        let runtime = registry.lookup(Some(&runtime_name))?;
        runtime.terminal_write(TerminalWriteParams { terminal_id, data })
    })
    .await
}

#[tauri::command]
pub async fn resize_remote_terminal(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    runtime_name: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        let runtime = registry.lookup(Some(&runtime_name))?;
        runtime.terminal_resize(TerminalResizeParams {
            terminal_id,
            cols,
            rows,
        })?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn close_remote_terminal(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    subscriptions: tauri::State<'_, Arc<RemoteTerminalSubscriptions>>,
    owned: tauri::State<'_, Arc<OwnedTerminals>>,
    runtime_name: String,
    terminal_id: String,
) -> CmdResult<()> {
    let registry = Arc::clone(&registry);
    let subscriptions = Arc::clone(&subscriptions);
    let owned = Arc::clone(&owned);
    run_blocking(move || {
        let runtime = registry.lookup(Some(&runtime_name))?;
        let close_result = runtime.terminal_close(TerminalCloseParams {
            terminal_id: terminal_id.clone(),
        });
        // Always tear down the subscription, even if the server
        // returned an error — leaving it registered would leak the
        // callback. The Exited event will still fire if the PTY was
        // alive; the subscription holds it until removed.
        subscriptions.remove(&terminal_id);
        // Forget ownership regardless of server outcome. A failed
        // close almost always means the daemon's gone (and the PTY
        // with it) — keeping a stale entry would confuse the
        // Reattach UI.
        if owned.remove(&runtime_name, &terminal_id) {
            persist_owned_terminals(&owned);
        }
        close_result.map(|_| ())
    })
    .await
}

/// Persist the `OwnedTerminals` snapshot to its sidecar JSON.
/// Best-effort: errors log but don't propagate (the in-memory
/// state stays authoritative for the running session).
fn persist_owned_terminals(owned: &Arc<OwnedTerminals>) {
    let data_dir = match crate::data_dir::data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            tracing::warn!(
                error = %format!("{err:#}"),
                "remote-runner: cannot resolve data dir; skipping owned-terminals persist"
            );
            return;
        }
    };
    owned.save_to_disk(&data_dir);
}

/// Snapshot the surviving terminals on the named remote. The
/// daemon returns *every* live PTY (not just those this desktop
/// opened); the Reattach UI joins this with
/// `list_owned_terminals` to mark our sessions vs. others.
#[tauri::command]
pub async fn list_remote_terminals(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    runtime_name: String,
) -> CmdResult<TerminalListResult> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        let runtime = registry.lookup(Some(&runtime_name))?;
        runtime.terminal_list(TerminalListParams {})
    })
    .await
}

/// Synchronous: read the desktop's owned-set for a runtime. No
/// round-trip to the daemon — this is the cached "what did *we*
/// open last time?" view.
#[tauri::command]
pub fn list_owned_terminals(
    owned: tauri::State<'_, Arc<OwnedTerminals>>,
    runtime_name: String,
) -> CmdResult<Vec<String>> {
    let mut ids: Vec<String> = owned.list_for_runtime(&runtime_name).into_iter().collect();
    ids.sort();
    Ok(ids)
}

/// Re-bind an existing remote terminal's live output to a fresh
/// Tauri channel. Mirror of [`open_remote_terminal`] but talks to
/// `terminal.attach` instead of `terminal.open`, so the desktop
/// can resume a session opened by a previous instance.
///
/// The result includes the server-side scrollback captured since
/// the previous attach (or since open). The UI paints that first,
/// then live events arrive on `channel` going forward.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn attach_remote_terminal(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    subscriptions: tauri::State<'_, Arc<RemoteTerminalSubscriptions>>,
    owned: tauri::State<'_, Arc<OwnedTerminals>>,
    runtime_name: String,
    terminal_id: String,
    channel: Channel<TerminalEventNotification>,
) -> CmdResult<TerminalAttachResult> {
    let registry = Arc::clone(&registry);
    let subscriptions = Arc::clone(&subscriptions);
    let owned = Arc::clone(&owned);
    run_blocking(move || {
        let runtime = registry.lookup(Some(&runtime_name))?;

        // Same shape as open: subscribe BEFORE the server-side
        // notifier swap so live events can't be lost between
        // attach returning and our subscription registering.
        let term_id_for_filter = terminal_id.clone();
        let subscription = runtime
            .subscribe_terminal_events(Box::new(move |event| {
                if event.terminal_id == term_id_for_filter {
                    let _ = channel.send(event);
                }
            }))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "runtime `{runtime_name}` does not stream terminal events \
                     (only connected remote runtimes do)"
                )
            })?;

        let result = runtime.terminal_attach(TerminalAttachParams {
            terminal_id: terminal_id.clone(),
        });
        match result {
            Ok(attach) => {
                // `insert` replaces any prior subscription for
                // this terminal_id — that's fine, the old one was
                // for a previous session of this same desktop or
                // for the open call.
                subscriptions.insert(terminal_id.clone(), subscription);
                // Attach implies "this desktop now owns this
                // terminal" — record it so future reattach flows
                // surface it under "your sessions".
                if owned.insert(&runtime_name, &terminal_id) {
                    persist_owned_terminals(&owned);
                }
                Ok(attach)
            }
            Err(err) => {
                // No `terminal_id` → no entry to remove from
                // owned-state (we only insert on success). The
                // subscription unregisters on drop.
                drop(subscription);
                Err(err)
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{RemoteRuntime, RuntimeKind};
    use anyhow::Result;
    use std::path::Path;

    struct StubRuntime {
        hostname: &'static str,
    }
    impl RemoteRuntime for StubRuntime {
        fn runtime_health(&self) -> Result<RuntimeHealth> {
            Ok(RuntimeHealth {
                kind: RuntimeKind::Remote {
                    host: self.hostname.into(),
                },
                hostname: self.hostname.into(),
                version: "stub".into(),
            })
        }
        fn workspace_status(&self, _: &Path) -> Result<WorkspaceStatusResult> {
            Ok(WorkspaceStatusResult {
                is_clean: true,
                changed_paths: vec![],
            })
        }
        fn workspace_branch_info(
            &self,
            _: &Path,
        ) -> Result<crate::remote::methods::WorkspaceBranchInfoResult> {
            Ok(crate::remote::methods::WorkspaceBranchInfoResult {
                current_branch: "main".into(),
                head_commit: "stub-sha".into(),
                upstream_ref: None,
            })
        }
        fn ping(&self) -> Result<()> {
            Ok(())
        }
    }

    fn registry_with_stub_remote() -> Arc<RuntimeRegistry> {
        let registry = Arc::new(RuntimeRegistry::new());
        registry
            .register(
                "stub.box",
                Arc::new(StubRuntime {
                    hostname: "stub.box",
                }),
                None,
            )
            .unwrap();
        registry
    }

    #[test]
    fn list_remote_runtimes_marks_local_entry() {
        let registry = registry_with_stub_remote();
        let entries = list_remote_runtimes_inner(&registry).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "local");
        assert!(entries[0].is_local);
        assert_eq!(entries[1].name, "stub.box");
        assert!(!entries[1].is_local);
    }

    // The Tauri-command wrappers above expect `tauri::State<...>`,
    // which can't easily be constructed from unit tests. The helpers
    // below mirror the command bodies so we can exercise the same
    // logic with a plain `&Arc<RuntimeRegistry>`.
    fn list_remote_runtimes_inner(registry: &Arc<RuntimeRegistry>) -> CmdResult<Vec<RuntimeEntry>> {
        Ok(registry
            .names()
            .into_iter()
            .map(|name| {
                let is_local = name == LOCAL_RUNTIME_NAME;
                let state = registry.state(&name).unwrap_or(RuntimeState::Connected);
                let config = if is_local {
                    None
                } else {
                    registry.config_for(&name)
                };
                RuntimeEntry {
                    name,
                    is_local,
                    state,
                    config,
                }
            })
            .collect())
    }

    #[test]
    fn disconnect_remote_runtime_removes_only_named_entry() {
        let registry = registry_with_stub_remote();
        registry.unregister("stub.box").unwrap();
        let entries = list_remote_runtimes_inner(&registry).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "local");
    }

    // ── path resolution ──────────────────────────────────────────

    #[test]
    fn resolve_local_helmor_server_path_honours_env_override_when_file_exists() {
        // Write a fake binary, point HELMOR_SERVER_PATH at it, assert
        // the resolver returns that path. Restores the env on drop.
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("helmor-server");
        std::fs::write(&fake, b"#!/bin/sh\n").unwrap();

        let guard = EnvGuard::set("HELMOR_SERVER_PATH", fake.display().to_string());
        let resolved = resolve_local_helmor_server_path().expect("should resolve via env");
        assert_eq!(resolved, fake);
        drop(guard);
    }

    #[test]
    fn resolve_local_helmor_server_path_rejects_env_override_that_is_not_a_file() {
        let guard = EnvGuard::set("HELMOR_SERVER_PATH", "/definitely/not/here");
        let err = resolve_local_helmor_server_path().expect_err("missing file should error");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("/definitely/not/here") && msg.contains("not a file"),
            "should name the bad path: {msg}"
        );
        drop(guard);
    }

    /// RAII guard so failing tests don't leak env state into siblings.
    /// The whole test process shares one env, so a forgotten set leaks.
    struct EnvGuard {
        key: &'static str,
        prior: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let prior = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prior }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prior {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn get_runtime_health_routes_via_registry_lookup() {
        let registry = registry_with_stub_remote();
        // Local
        let local = registry.lookup(None).unwrap().runtime_health().unwrap();
        assert_eq!(local.kind, RuntimeKind::Local);
        // Named remote
        let remote = registry
            .lookup(Some("stub.box"))
            .unwrap()
            .runtime_health()
            .unwrap();
        assert!(matches!(remote.kind, RuntimeKind::Remote { .. }));
        assert_eq!(remote.hostname, "stub.box");
    }

    // ── resolve_runtime_for_call ─────────────────────────────────

    fn bindings_with(workspace_id: &str, runtime_name: &str) -> Arc<WorkspaceRuntimeBindings> {
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());
        bindings.set(workspace_id, runtime_name);
        bindings
    }

    #[test]
    fn resolve_returns_local_when_neither_workspace_id_nor_runtime_name_is_set() {
        let registry = registry_with_stub_remote();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());
        let runtime = resolve_runtime_for_call(&registry, &bindings, None, None).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    #[test]
    fn explicit_runtime_name_wins_over_workspace_binding() {
        // Workspace is bound to `stub.box`, but the caller passes
        // `runtime_name = "local"`. The override should win.
        let registry = registry_with_stub_remote();
        let bindings = bindings_with("ws-1", "stub.box");
        let runtime =
            resolve_runtime_for_call(&registry, &bindings, Some("ws-1"), Some("local")).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    #[test]
    fn workspace_id_alone_resolves_through_the_binding() {
        let registry = registry_with_stub_remote();
        let bindings = bindings_with("ws-1", "stub.box");
        let runtime = resolve_runtime_for_call(&registry, &bindings, Some("ws-1"), None).unwrap();
        let health = runtime.runtime_health().unwrap();
        assert!(matches!(health.kind, RuntimeKind::Remote { .. }));
        assert_eq!(health.hostname, "stub.box");
    }

    #[test]
    fn workspace_id_with_unbound_workspace_falls_back_to_local() {
        let registry = registry_with_stub_remote();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());
        let runtime =
            resolve_runtime_for_call(&registry, &bindings, Some("ws-unbound"), None).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    #[test]
    fn workspace_binding_pointing_at_unregistered_runtime_falls_back_to_local() {
        // The binding survives a disconnect; the resolver falls back
        // to local so the caller still gets *something* until the
        // bound runtime reconnects.
        let registry = registry_with_stub_remote();
        let bindings = bindings_with("ws-1", "never-registered");
        let runtime = resolve_runtime_for_call(&registry, &bindings, Some("ws-1"), None).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    #[test]
    fn empty_strings_are_treated_as_absent() {
        // Frontend may submit `""` for an uninitialised input; the
        // resolver should not treat that as a valid lookup target.
        let registry = registry_with_stub_remote();
        let bindings = bindings_with("ws-1", "stub.box");
        let runtime = resolve_runtime_for_call(&registry, &bindings, Some(""), Some("")).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    // ── column-vs-sidecar precedence (phase 22b) ──────────────────
    //
    // These exercise `resolve_runtime_for_call_with_column` directly
    // so the precedence rule can be verified without a real DB.
    // Production callers go through `resolve_runtime_for_call`, which
    // calls into `models::workspaces::load_workspace_runtime_name`
    // and swallows the inevitable "no pool initialised in unit tests"
    // error — falling through to the sidecar path the older tests
    // already cover.

    #[test]
    fn column_binding_wins_over_sidecar_binding() {
        // Both surfaces have a (different) binding for the same
        // workspace. The column-resolved value must be the one the
        // resolver picks — that's the 22b precedence flip's whole
        // point.
        let registry = registry_with_stub_remote();
        let bindings = bindings_with("ws-1", "never-registered"); // sidecar points at a bad entry
        let runtime = resolve_runtime_for_call_with_column(
            &registry,
            &bindings,
            Some("ws-1"),
            None,
            Some("stub.box"), // column points at the real entry
        )
        .unwrap();
        let health = runtime.runtime_health().unwrap();
        assert!(matches!(health.kind, RuntimeKind::Remote { .. }));
        assert_eq!(health.hostname, "stub.box");
    }

    #[test]
    fn sidecar_binding_used_when_column_is_absent() {
        // Legacy path: column hasn't been backfilled yet (e.g. the
        // workspace row predates the migration) but the sidecar JSON
        // carries a binding. Resolver still picks the sidecar.
        let registry = registry_with_stub_remote();
        let bindings = bindings_with("ws-1", "stub.box");
        let runtime = resolve_runtime_for_call_with_column(
            &registry,
            &bindings,
            Some("ws-1"),
            None,
            None, // column NULL
        )
        .unwrap();
        let health = runtime.runtime_health().unwrap();
        assert_eq!(health.hostname, "stub.box");
    }

    #[test]
    fn explicit_runtime_name_still_wins_over_both_column_and_sidecar() {
        // The explicit `runtime_name` override is the top of the
        // precedence chain — neither column nor sidecar should
        // matter when it's set.
        let registry = registry_with_stub_remote();
        let bindings = bindings_with("ws-1", "stub.box");
        let runtime = resolve_runtime_for_call_with_column(
            &registry,
            &bindings,
            Some("ws-1"),
            Some("local"),
            Some("stub.box"),
        )
        .unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    #[test]
    fn column_binding_pointing_at_unregistered_runtime_falls_back_to_local() {
        // A column may carry a binding for a runtime that's been
        // disconnected since the user set it. The resolver should
        // fall back to local (with a warn log) rather than erroring.
        let registry = registry_with_stub_remote();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new()); // sidecar empty
        let runtime = resolve_runtime_for_call_with_column(
            &registry,
            &bindings,
            Some("ws-1"),
            None,
            Some("never-registered"),
        )
        .unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    #[test]
    fn column_binding_ignored_when_workspace_id_is_empty_string() {
        // Mirrors the sidecar behaviour: `""` workspace id is
        // treated as "no binding" so a stale column value can't
        // accidentally route the call.
        let registry = registry_with_stub_remote();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());
        let runtime = resolve_runtime_for_call_with_column(
            &registry,
            &bindings,
            Some(""),
            None,
            Some("stub.box"), // would route if workspace_id mattered
        )
        .unwrap();
        assert_eq!(runtime.runtime_health().unwrap().kind, RuntimeKind::Local);
    }

    // ── workspace inspector ops (phase 20c) ──────────────────────
    //
    // For each new command we exercise:
    //   1. The resolver picks the right runtime (explicit
    //      `runtime_name`, workspace binding, no-binding fallback).
    //   2. Params flow through to the trait method untouched.
    //   3. The trait method's return value bubbles back unchanged.
    //
    // `InspectorStubRuntime` records every call so the assertions
    // can verify both axes from one fixture.

    use crate::remote::methods::{
        WorkspaceChangesParams, WorkspaceChangesResult, WorkspaceFileTreeParams,
        WorkspaceFileTreeResult, WorkspaceMutateFileAction, WorkspaceMutateFileParams,
        WorkspaceMutateFileResult, WorkspaceReadFileAtRefParams, WorkspaceReadFileAtRefResult,
        WorkspaceReadFileParams, WorkspaceStatFileParams,
    };
    use crate::workspace::files::{
        EditorFileListItem, EditorFilePrefetchItem, EditorFileReadResponse, EditorFileStatResponse,
    };
    use std::sync::Mutex;

    /// Stub runtime that records every inspector call so tests can
    /// assert both "which runtime got it" + "with what params".
    #[derive(Default)]
    struct InspectorStubRuntime {
        hostname: &'static str,
        file_tree_calls: Mutex<Vec<WorkspaceFileTreeParams>>,
        changes_calls: Mutex<Vec<WorkspaceChangesParams>>,
        read_calls: Mutex<Vec<WorkspaceReadFileParams>>,
        read_at_ref_calls: Mutex<Vec<WorkspaceReadFileAtRefParams>>,
        stat_calls: Mutex<Vec<WorkspaceStatFileParams>>,
        mutate_calls: Mutex<Vec<WorkspaceMutateFileParams>>,
    }

    impl InspectorStubRuntime {
        fn new(hostname: &'static str) -> Self {
            Self {
                hostname,
                ..Default::default()
            }
        }

        fn fixed_file_tree_entry(path: &str) -> EditorFileListItem {
            EditorFileListItem {
                path: path.to_string(),
                absolute_path: format!("/stub/{path}"),
                name: path.to_string(),
                status: "M".into(),
                staged_insertions: 0,
                staged_deletions: 0,
                unstaged_insertions: 0,
                unstaged_deletions: 0,
                committed_insertions: 0,
                committed_deletions: 0,
                is_binary: false,
                staged_status: None,
                unstaged_status: None,
                committed_status: None,
            }
        }
    }

    impl RemoteRuntime for InspectorStubRuntime {
        fn runtime_health(&self) -> Result<RuntimeHealth> {
            Ok(RuntimeHealth {
                kind: RuntimeKind::Remote {
                    host: self.hostname.into(),
                },
                hostname: self.hostname.into(),
                version: "inspector-stub".into(),
            })
        }
        fn workspace_status(&self, _: &Path) -> Result<WorkspaceStatusResult> {
            Ok(WorkspaceStatusResult {
                is_clean: true,
                changed_paths: vec![],
            })
        }
        fn workspace_branch_info(&self, _: &Path) -> Result<WorkspaceBranchInfoResult> {
            Ok(WorkspaceBranchInfoResult {
                current_branch: "main".into(),
                head_commit: "stub-sha".into(),
                upstream_ref: None,
            })
        }
        fn ping(&self) -> Result<()> {
            Ok(())
        }
        fn workspace_file_tree(
            &self,
            params: WorkspaceFileTreeParams,
        ) -> Result<WorkspaceFileTreeResult> {
            // Encode the workspace_dir into the entry path so the
            // test can prove the param flowed through.
            let echo = format!("echo:{}", params.workspace_dir);
            self.file_tree_calls.lock().unwrap().push(params);
            Ok(WorkspaceFileTreeResult {
                entries: vec![Self::fixed_file_tree_entry(&echo)],
            })
        }
        fn workspace_changes(
            &self,
            params: WorkspaceChangesParams,
        ) -> Result<WorkspaceChangesResult> {
            // Echo the include_content flag through the item count so
            // the test can verify it flowed verbatim.
            let item_count = if params.include_content { 2 } else { 1 };
            let prefetched = if params.include_content {
                vec![EditorFilePrefetchItem {
                    absolute_path: "/stub/file.txt".into(),
                    content: "prefetched".into(),
                }]
            } else {
                Vec::new()
            };
            self.changes_calls.lock().unwrap().push(params);
            Ok(WorkspaceChangesResult {
                items: (0..item_count)
                    .map(|i| Self::fixed_file_tree_entry(&format!("change-{i}.txt")))
                    .collect(),
                prefetched,
            })
        }
        fn workspace_read_file(
            &self,
            params: WorkspaceReadFileParams,
        ) -> Result<EditorFileReadResponse> {
            let path = format!("/stub/{}/{}", params.workspace_dir, params.relative_path);
            self.read_calls.lock().unwrap().push(params);
            Ok(EditorFileReadResponse {
                path,
                content: "stub-content".into(),
                mtime_ms: 1234,
            })
        }
        fn workspace_read_file_at_ref(
            &self,
            params: WorkspaceReadFileAtRefParams,
        ) -> Result<WorkspaceReadFileAtRefResult> {
            // Echo the ref into the content so the test asserts the
            // git_ref reached the trait method.
            let content = if params.git_ref == "MISSING" {
                None
            } else {
                Some(format!("at:{}", params.git_ref))
            };
            self.read_at_ref_calls.lock().unwrap().push(params);
            Ok(WorkspaceReadFileAtRefResult { content })
        }
        fn workspace_stat_file(
            &self,
            params: WorkspaceStatFileParams,
        ) -> Result<EditorFileStatResponse> {
            let path = format!("/stub/{}/{}", params.workspace_dir, params.relative_path);
            self.stat_calls.lock().unwrap().push(params);
            Ok(EditorFileStatResponse {
                path,
                exists: true,
                is_file: true,
                mtime_ms: Some(999),
                size: Some(42),
            })
        }
        fn workspace_mutate_file(
            &self,
            params: WorkspaceMutateFileParams,
        ) -> Result<WorkspaceMutateFileResult> {
            // For Write actions, surface a fake mtime so the test can
            // tell write from the non-mtime variants.
            let mtime_ms =
                matches!(params.action, WorkspaceMutateFileAction::Write { .. }).then_some(777_i64);
            self.mutate_calls.lock().unwrap().push(params);
            Ok(WorkspaceMutateFileResult { mtime_ms })
        }
    }

    fn registry_with_inspector_stub() -> (Arc<RuntimeRegistry>, Arc<InspectorStubRuntime>) {
        let registry = Arc::new(RuntimeRegistry::new());
        let stub = Arc::new(InspectorStubRuntime::new("stub.box"));
        registry
            .register(
                "stub.box",
                Arc::clone(&stub) as Arc<dyn RemoteRuntime>,
                None,
            )
            .unwrap();
        (registry, stub)
    }

    // ── get_workspace_file_tree ───────────────────────────────────

    #[test]
    fn get_workspace_file_tree_with_no_binding_routes_to_local() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        // Local runtime's `workspace_file_tree` walks the actual fs;
        // passing a path that doesn't exist is a clean way to prove
        // we hit the local runtime (it returns an empty list rather
        // than the stub's echo entry).
        let result = get_workspace_file_tree_inner(
            &registry,
            &bindings,
            "/path/that/does/not/exist".into(),
            None,
            None,
        )
        .unwrap();
        assert!(
            result.entries.is_empty(),
            "local runtime walks the fs and returns nothing for a missing dir"
        );
        assert!(
            stub.file_tree_calls.lock().unwrap().is_empty(),
            "stub should not have been called when no binding is set"
        );
    }

    #[test]
    fn get_workspace_file_tree_with_runtime_name_routes_to_named_runtime() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        let result = get_workspace_file_tree_inner(
            &registry,
            &bindings,
            "/ws".into(),
            None,
            Some("stub.box"),
        )
        .unwrap();
        let recorded = stub.file_tree_calls.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].workspace_dir, "/ws");
        // The stub encodes the workspace_dir back into its echo entry.
        assert_eq!(result.entries[0].path, "echo:/ws");
    }

    #[test]
    fn get_workspace_file_tree_with_workspace_binding_routes_through_the_binding() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = bindings_with("ws-bound", "stub.box");

        get_workspace_file_tree_inner(&registry, &bindings, "/ws".into(), Some("ws-bound"), None)
            .unwrap();
        let recorded = stub.file_tree_calls.lock().unwrap();
        assert_eq!(
            recorded.len(),
            1,
            "binding should resolve to the stub runtime"
        );
    }

    #[test]
    fn get_workspace_file_tree_explicit_local_overrides_binding() {
        // Workspace is bound to stub.box but caller passes
        // runtime_name="local" — the explicit override must win and
        // the stub must NOT see the call.
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = bindings_with("ws-bound", "stub.box");

        get_workspace_file_tree_inner(
            &registry,
            &bindings,
            "/path/that/does/not/exist".into(),
            Some("ws-bound"),
            Some("local"),
        )
        .unwrap();
        assert!(
            stub.file_tree_calls.lock().unwrap().is_empty(),
            "explicit `runtime_name=local` must beat the binding"
        );
    }

    // ── get_workspace_changes ─────────────────────────────────────

    #[test]
    fn get_workspace_changes_flows_include_content_to_the_trait() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        let result_without = get_workspace_changes_inner(
            &registry,
            &bindings,
            "/ws".into(),
            false,
            None,
            Some("stub.box"),
        )
        .unwrap();
        assert_eq!(result_without.items.len(), 1);
        assert!(result_without.prefetched.is_empty());

        let result_with = get_workspace_changes_inner(
            &registry,
            &bindings,
            "/ws".into(),
            true,
            None,
            Some("stub.box"),
        )
        .unwrap();
        assert_eq!(result_with.items.len(), 2);
        assert_eq!(result_with.prefetched.len(), 1);

        let recorded = stub.changes_calls.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert!(!recorded[0].include_content);
        assert!(recorded[1].include_content);
    }

    // ── read_workspace_file ───────────────────────────────────────

    #[test]
    fn read_workspace_file_forwards_workspace_dir_and_relative_path() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        let resp = read_workspace_file_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "src/main.rs".into(),
            None,
            Some("stub.box"),
        )
        .unwrap();
        assert_eq!(resp.content, "stub-content");
        assert_eq!(resp.mtime_ms, 1234);

        let recorded = stub.read_calls.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].workspace_dir, "/ws");
        assert_eq!(recorded[0].relative_path, "src/main.rs");
    }

    #[test]
    fn read_workspace_file_propagates_runtime_error_to_caller() {
        // No registered runtime + an explicit override that doesn't
        // exist should surface a registry-lookup error — the inner
        // helper must not swallow it.
        let registry = Arc::new(RuntimeRegistry::new());
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        let err = read_workspace_file_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "src/main.rs".into(),
            None,
            Some("not-registered"),
        )
        .expect_err("missing runtime must error");
        let msg = format!("{err}");
        assert!(
            msg.contains("not-registered"),
            "error should name the missing runtime: {msg}"
        );
    }

    // ── read_workspace_file_at_ref ────────────────────────────────

    #[test]
    fn read_workspace_file_at_ref_forwards_git_ref_to_the_trait() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        let resp = read_workspace_file_at_ref_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "src/main.rs".into(),
            "origin/main".into(),
            None,
            Some("stub.box"),
        )
        .unwrap();
        assert_eq!(resp.content, Some("at:origin/main".into()));

        let recorded = stub.read_at_ref_calls.lock().unwrap();
        assert_eq!(recorded[0].git_ref, "origin/main");
    }

    #[test]
    fn read_workspace_file_at_ref_surfaces_missing_as_none() {
        // Stub returns `None` content when the git_ref is "MISSING".
        // Verifies the trait's Option<String> contract round-trips.
        let (registry, _stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        let resp = read_workspace_file_at_ref_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "src/main.rs".into(),
            "MISSING".into(),
            None,
            Some("stub.box"),
        )
        .unwrap();
        assert!(resp.content.is_none());
    }

    // ── stat_workspace_file ───────────────────────────────────────

    #[test]
    fn stat_workspace_file_forwards_params_and_returns_metadata() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        let resp = stat_workspace_file_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "Cargo.toml".into(),
            None,
            Some("stub.box"),
        )
        .unwrap();
        assert!(resp.exists);
        assert!(resp.is_file);
        assert_eq!(resp.size, Some(42));
        assert_eq!(resp.mtime_ms, Some(999));

        let recorded = stub.stat_calls.lock().unwrap();
        assert_eq!(recorded[0].relative_path, "Cargo.toml");
    }

    // ── mutate_workspace_file ─────────────────────────────────────

    #[test]
    fn mutate_workspace_file_forwards_each_action_variant() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = Arc::new(WorkspaceRuntimeBindings::new());

        // Drive every action variant; assert the action reaches the
        // trait method intact (no flattening / no swallowed content).
        let write_resp = mutate_workspace_file_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "file.txt".into(),
            WorkspaceMutateFileAction::Write {
                content: "new body\n".into(),
            },
            None,
            Some("stub.box"),
        )
        .unwrap();
        assert_eq!(
            write_resp.mtime_ms,
            Some(777),
            "write should surface the stub mtime"
        );

        for action in [
            WorkspaceMutateFileAction::Discard,
            WorkspaceMutateFileAction::Stage,
            WorkspaceMutateFileAction::Unstage,
        ] {
            let resp = mutate_workspace_file_inner(
                &registry,
                &bindings,
                "/ws".into(),
                "file.txt".into(),
                action,
                None,
                Some("stub.box"),
            )
            .unwrap();
            assert!(
                resp.mtime_ms.is_none(),
                "non-write actions must not surface an mtime"
            );
        }

        let recorded = stub.mutate_calls.lock().unwrap();
        assert_eq!(recorded.len(), 4);
        // Spot-check the write variant carried its content payload.
        let write_call = recorded
            .iter()
            .find(|p| matches!(p.action, WorkspaceMutateFileAction::Write { .. }))
            .expect("write call recorded");
        if let WorkspaceMutateFileAction::Write { content } = &write_call.action {
            assert_eq!(content, "new body\n");
        }
        // Spot-check the rest by variant tag.
        assert!(recorded
            .iter()
            .any(|p| matches!(p.action, WorkspaceMutateFileAction::Discard)));
        assert!(recorded
            .iter()
            .any(|p| matches!(p.action, WorkspaceMutateFileAction::Stage)));
        assert!(recorded
            .iter()
            .any(|p| matches!(p.action, WorkspaceMutateFileAction::Unstage)));
    }

    #[test]
    fn mutate_workspace_file_routes_through_workspace_binding_by_default() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = bindings_with("ws-bound", "stub.box");

        mutate_workspace_file_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "file.txt".into(),
            WorkspaceMutateFileAction::Stage,
            Some("ws-bound"),
            None,
        )
        .unwrap();
        assert_eq!(
            stub.mutate_calls.lock().unwrap().len(),
            1,
            "binding should resolve mutate to the bound runtime"
        );
    }
}
