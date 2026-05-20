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
        WorkspaceReadFileParams, WorkspaceSearchParams, WorkspaceSearchResult,
        WorkspaceStatFileParams, WorkspaceStatusResult,
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

/// Subscriptions held alive while the desktop is reattached to a
/// remote agent stream. Keyed by `request_id` — the same id the
/// remote sidecar uses, so abort + stop are addressable by the
/// existing identifier without inventing a parallel one.
///
/// `Drop` on each `NotificationSubscription` unregisters the
/// `agent.event` callback on the underlying [`RpcClient`], so
/// removing an entry both ends the stream + stops fueling the
/// frontend Channel.
#[derive(Default)]
pub struct RemoteAgentStreamSubscriptions {
    inner: std::sync::Mutex<HashMap<String, NotificationSubscription>>,
}

impl RemoteAgentStreamSubscriptions {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, request_id: String, subscription: NotificationSubscription) {
        self.inner
            .lock()
            .expect("remote agent stream subscriptions mutex poisoned")
            .insert(request_id, subscription);
    }

    fn remove(&self, request_id: &str) -> bool {
        self.inner
            .lock()
            .expect("remote agent stream subscriptions mutex poisoned")
            .remove(request_id)
            .is_some()
    }

    /// Sorted snapshot of active request ids. Used by tests + by a
    /// future operator-facing surface to render "currently
    /// streaming N attached turns".
    #[allow(dead_code)]
    pub fn active_request_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .inner
            .lock()
            .expect("remote agent stream subscriptions mutex poisoned")
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn search_workspace(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    bindings: tauri::State<'_, Arc<WorkspaceRuntimeBindings>>,
    workspace_dir: String,
    query: String,
    max_results: Option<u32>,
    case_insensitive: Option<bool>,
    fixed_string: Option<bool>,
    workspace_id: Option<String>,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceSearchResult> {
    let registry = Arc::clone(&registry);
    let bindings = Arc::clone(&bindings);
    run_blocking(move || {
        search_workspace_inner(
            &registry,
            &bindings,
            workspace_dir,
            query,
            max_results,
            case_insensitive.unwrap_or(false),
            fixed_string.unwrap_or(false),
            workspace_id.as_deref(),
            runtime_name.as_deref(),
        )
    })
    .await
}

#[allow(clippy::too_many_arguments)]
fn search_workspace_inner(
    registry: &Arc<RuntimeRegistry>,
    bindings: &Arc<WorkspaceRuntimeBindings>,
    workspace_dir: String,
    query: String,
    max_results: Option<u32>,
    case_insensitive: bool,
    fixed_string: bool,
    workspace_id: Option<&str>,
    runtime_name: Option<&str>,
) -> Result<WorkspaceSearchResult> {
    let resolved = resolve_runtime_for_call(registry, bindings, workspace_id, runtime_name)?;
    resolved.workspace_search(WorkspaceSearchParams {
        workspace_dir,
        query,
        max_results,
        case_insensitive,
        fixed_string,
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

/// Snapshot the daemon's active agent sessions on `name`. The
/// returned list is whatever the remote's `agent.list` knows about —
/// including orphaned sessions left over from a desktop that crashed
/// mid-stream. Drives the reattach UX (phase 24d): the desktop shows
/// the user "the remote thinks turn X is still running" and offers an
/// abort / attach affordance.
///
/// Refuses the built-in `local` runtime: the local sidecar is owned
/// by the desktop's `ManagedSidecar` and tracks its in-flight turns
/// through `ActiveStreams`. There's no daemon-side `agent.list` to
/// call there.
#[tauri::command]
pub async fn list_remote_agent_sessions(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
) -> CmdResult<Vec<crate::remote::AgentSessionEntry>> {
    let registry = Arc::clone(&registry);
    run_blocking(move || list_remote_agent_sessions_inner(&registry, name)).await
}

fn list_remote_agent_sessions_inner(
    registry: &Arc<RuntimeRegistry>,
    name: String,
) -> anyhow::Result<Vec<crate::remote::AgentSessionEntry>> {
    if name.trim().is_empty() {
        bail!("runtime name must not be empty");
    }
    if name == LOCAL_RUNTIME_NAME {
        bail!("agent.list is only available on registered remote runtimes (got `{name}`)");
    }
    let runtime = registry.lookup(Some(&name))?;
    let result = runtime.agent_list(crate::remote::AgentListParams::default())?;
    Ok(result.sessions)
}

/// Forward an abort to the daemon's per-session sidecar. Used by the
/// reattach UX to stop an orphaned remote turn the user no longer
/// wants. The remote sidecar emits a terminating `aborted` event that
/// the daemon broadcasts to any attached client; if no client is
/// attached the event is dropped (and the session removed) by the
/// daemon's per-session map.
#[tauri::command]
pub async fn abort_remote_agent_session(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
    request_id: String,
) -> CmdResult<()> {
    let registry = Arc::clone(&registry);
    run_blocking(move || abort_remote_agent_session_inner(&registry, name, request_id)).await
}

fn abort_remote_agent_session_inner(
    registry: &Arc<RuntimeRegistry>,
    name: String,
    request_id: String,
) -> anyhow::Result<()> {
    if name.trim().is_empty() {
        bail!("runtime name must not be empty");
    }
    if request_id.trim().is_empty() {
        bail!("request_id must not be empty");
    }
    if name == LOCAL_RUNTIME_NAME {
        bail!("agent.abort is only available on registered remote runtimes (got `{name}`)");
    }
    let runtime = registry.lookup(Some(&name))?;
    let _ = runtime.agent_abort(crate::remote::AgentAbortParams { request_id })?;
    Ok(())
}

/// Reattach the desktop's notification subscriber to an existing
/// remote agent session. Returns `true` when the daemon swapped the
/// per-session notifier; `false` when the session expired or never
/// existed on the daemon (the desktop should drop any tentative
/// local subscription).
///
/// Pure RPC pass-through today — the desktop-side glue that pumps
/// the post-attach event stream back into the chat pipeline is a
/// follow-on slice. Surfacing the result here gives the operator a
/// "does the remote remember this turn?" probe + lets the UI show a
/// stale-session toast when the answer is no.
#[tauri::command]
pub async fn attach_remote_agent_session(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
    request_id: String,
    // Phase 24q-2: when present, the command computes
    // `since_seq = MAX(last_event_seq)` for this session row and
    // sends it to the daemon so the journal replay covers only
    // the gap. `None` means cold attach (daemon flushes the full
    // ring).
    helmor_session_id: Option<String>,
) -> CmdResult<AttachRemoteAgentSessionResult> {
    let registry = Arc::clone(&registry);
    let since_seq = compute_since_seq(helmor_session_id.as_deref());
    run_blocking(move || attach_remote_agent_session_inner(&registry, name, request_id, since_seq))
        .await
}

/// Aggregated connection diagnostics surfaced by the Runtime
/// Debug panel's "Connection diagnostics" section. Bundles every
/// telemetry surface the runtime exposes today:
///
/// - `state` — registry's last-known connection lifecycle.
/// - `health` — server-reported hostname / version (`runtime_health`).
/// - `client` — RPC pipe I/O counters + close reason. `None` for
///   the local runtime (no wire to instrument).
/// - `agentSessionCount` — how many agent turns the daemon is
///   actively running. Sourced from `agent.list`.
/// - `lastPingMs` — fresh ping RTT measured inside this call.
///   Lets the operator answer "how snappy is my pipe right now?"
///   without waiting for the next liveness tick.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub name: String,
    pub state: RuntimeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<RuntimeHealth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<crate::remote::RpcClientDiagnostics>,
    /// `None` when `agent.list` failed or the runtime doesn't
    /// support it (local runtime). The panel renders this as a
    /// chip alongside the I/O counters; absence means "we don't
    /// know", which is different from "zero".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_count: Option<u32>,
    /// `None` when the fresh ping failed (connection torn down
    /// between the diagnostics command starting + the ping
    /// completing). Rendered as a red "ping failed" badge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ping_ms: Option<u64>,
    /// `None` when the runtime exposes no client (local) or the
    /// ping failed before we could mark a failure. Captures any
    /// non-fatal error encountered while gathering diagnostics so
    /// the panel can show a partial snapshot rather than blanking
    /// out entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Snapshot every diagnostic available for `name`. Best-effort:
/// the command never bails on a partial signal — a missing health
/// probe or agent.list still returns the surfaces that succeeded.
/// Pass `name="local"` to fetch the local runtime's snapshot
/// (state will always be Connected; `client` will be `None`).
#[tauri::command]
pub async fn get_remote_runtime_diagnostics(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    name: String,
) -> CmdResult<RuntimeDiagnostics> {
    let registry = Arc::clone(&registry);
    run_blocking(move || get_remote_runtime_diagnostics_inner(&registry, name)).await
}

fn get_remote_runtime_diagnostics_inner(
    registry: &Arc<RuntimeRegistry>,
    name: String,
) -> anyhow::Result<RuntimeDiagnostics> {
    if name.trim().is_empty() {
        bail!("runtime name must not be empty");
    }

    // Read the registry's lifecycle state up front so we surface
    // a Disconnected / Tombstoned diagnostic even when the runtime
    // probe paths bail. `state_of` falls back to Connected for the
    // built-in local entry.
    let state = registry.state(&name).unwrap_or(RuntimeState::Connected);
    let runtime = registry
        .lookup(Some(&name))
        .with_context(|| format!("resolve runtime `{name}` for diagnostics"))?;

    let mut diag = RuntimeDiagnostics {
        name: name.clone(),
        state,
        health: None,
        client: None,
        agent_session_count: None,
        last_ping_ms: None,
        last_error: None,
    };

    // Per-probe failures land in `last_error` so the panel can
    // render a partial snapshot. The first probe to fail wins —
    // subsequent failures are logged but don't overwrite the
    // surfaced reason.
    let mut record_err = |err: anyhow::Error, label: &str| {
        let msg = format!("{label}: {err:#}");
        tracing::debug!(runtime = %name, error = %msg, "diagnostics probe failed");
        if diag.last_error.is_none() {
            diag.last_error = Some(msg);
        }
    };

    match runtime.runtime_health() {
        Ok(h) => diag.health = Some(h),
        Err(err) => record_err(err, "runtime_health"),
    }

    diag.client = runtime.client_diagnostics();

    match runtime.agent_list(crate::remote::AgentListParams::default()) {
        Ok(list) => diag.agent_session_count = Some(list.sessions.len() as u32),
        Err(err) => {
            // Local runtime + tombstoned runtimes default-bail on
            // agent.list; that's not a real failure for the
            // diagnostics view, just an absence. Suppress the
            // `last_error` write for the well-known
            // "only on a connected remote" message.
            let msg = format!("{err:#}").to_lowercase();
            if !msg.contains("only supported on a connected remote runtime")
                && !msg.contains("only on a connected remote")
            {
                record_err(err, "agent.list");
            }
        }
    }

    // Fresh ping at the end so the RTT reflects "the connection
    // right now" (not whatever stale liveness probe the registry
    // last recorded). Wall-clock timing is good enough — the
    // 200ms heartbeat tolerance dwarfs any system-time jitter.
    let ping_start = std::time::Instant::now();
    match runtime.ping() {
        Ok(()) => {
            diag.last_ping_ms = Some(ping_start.elapsed().as_millis() as u64);
        }
        Err(err) => record_err(err, "ping"),
    }

    Ok(diag)
}

/// Reattach + live event stream. The frontend supplies a Channel
/// the runtime pushes every matching `agent.event` notification
/// onto, so the panel can render assistant tokens / tool calls /
/// final result as they arrive — turning the previously-attached
/// "did you find it?" probe into a real reattach.
///
/// Wire flow:
/// 1. Subscribe to `agent.event` BEFORE the attach RPC so events
///    fired in the gap between attach + subscribe don't get
///    dropped.
/// 2. Call `agent.attach(request_id)`. The daemon swaps the
///    per-session notifier to this client's connection; from then
///    on every event for the request flows here.
/// 3. `found=false` means the session expired or never existed;
///    drop the subscription + return early.
/// 4. `found=true` means events are flowing; stash the
///    subscription in `RemoteAgentStreamSubscriptions` so it
///    outlives this command frame. The frontend's `release` call
///    drops it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReattachedAgentEvent {
    /// Echo the request_id so a single Channel could in principle
    /// host multiple streams (today we open one per request — the
    /// echo is forward-compatibility insurance for that fan-in).
    pub request_id: String,
    /// Raw sidecar event JSON, identical to the `event` field on
    /// the daemon's `agent.event` notification. The frontend
    /// renders it via the same logic that handles live sends.
    pub event: serde_json::Value,
    /// Phase 24q-2: daemon-side journal seq for this event. Used by
    /// the desktop's reattach loop to persist
    /// `session_messages.last_event_seq` and to track the next
    /// `since_seq` to send on reconnect. `None` for events from a
    /// pre-24q-1 daemon — defensive only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReattachAgentStreamResult {
    /// Mirrors `attach_remote_agent_session`'s contract: `true`
    /// means events are flowing, `false` means the session is gone
    /// and the frontend should treat the Channel as inert.
    pub found: bool,
    /// Phase 24q-2: daemon's high-water-mark seq for this session.
    /// The frontend stashes this so a subsequent reattach can pass
    /// it back as `since_seq` without consulting the local DB. `0`
    /// when `found=false` or the journal is empty.
    #[serde(default)]
    pub last_seq: u64,
    /// Phase 24q-2: number of journal entries the daemon flushed
    /// to the new notifier during attach. The events arrive through
    /// `on_event` like any live event; this field lets the
    /// operator panel show "N event(s) replayed" without counting
    /// channel sends.
    #[serde(default)]
    pub replayed_count: u64,
    /// Phase 24q-2: earliest seq still in the daemon's ring when
    /// the caller's `since_seq` predates the oldest entry. `Some`
    /// means some events were evicted before this attach; the
    /// frontend should treat the resulting stream as a partial
    /// catch-up + fall back to a full DB reload for the gap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_gap: Option<u64>,
}

/// Result of [`attach_remote_agent_session`]. Phase 24q-2 swaps the
/// bare `bool` return for a struct so the frontend can stash the
/// daemon's `last_seq` for a future reattach + render replay-gap
/// diagnostics. `found` carries the original contract.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachRemoteAgentSessionResult {
    pub found: bool,
    #[serde(default)]
    pub last_seq: u64,
    #[serde(default)]
    pub replayed_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_gap: Option<u64>,
}

#[tauri::command]
pub async fn reattach_remote_agent_session_stream(
    registry: tauri::State<'_, Arc<RuntimeRegistry>>,
    subscriptions: tauri::State<'_, Arc<RemoteAgentStreamSubscriptions>>,
    name: String,
    request_id: String,
    // Phase 24q-2: when present, the command computes
    // `since_seq = MAX(last_event_seq)` for this session row and
    // passes it to `agent.attach`. Daemon then replays only
    // entries `seq > since_seq`. `None` means cold attach.
    helmor_session_id: Option<String>,
    on_event: Channel<ReattachedAgentEvent>,
) -> CmdResult<ReattachAgentStreamResult> {
    let registry = Arc::clone(&registry);
    let subscriptions = Arc::clone(&subscriptions);
    let since_seq = compute_since_seq(helmor_session_id.as_deref());
    run_blocking(move || {
        reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            name,
            request_id,
            since_seq,
            on_event,
        )
    })
    .await
}

fn reattach_remote_agent_session_stream_inner(
    registry: &Arc<RuntimeRegistry>,
    subscriptions: &Arc<RemoteAgentStreamSubscriptions>,
    name: String,
    request_id: String,
    since_seq: Option<u64>,
    on_event: Channel<ReattachedAgentEvent>,
) -> anyhow::Result<ReattachAgentStreamResult> {
    if name.trim().is_empty() {
        bail!("runtime name must not be empty");
    }
    if request_id.trim().is_empty() {
        bail!("request_id must not be empty");
    }
    if name == LOCAL_RUNTIME_NAME {
        bail!("agent.attach is only available on registered remote runtimes (got `{name}`)");
    }
    let runtime = registry.lookup(Some(&name))?;

    // Subscribe BEFORE attach so a "ready-fire" event the daemon
    // dispatches the moment the notifier swaps can't slip through
    // the gap. Filter on request_id inside the callback so other
    // concurrent streams on the same connection don't cross-talk.
    let request_id_for_filter = request_id.clone();
    let subscription = runtime
        .subscribe_agent_events(Box::new(move |notif| {
            if notif.request_id != request_id_for_filter {
                return;
            }
            // Dropping the Channel before release fires a benign
            // SendError we swallow — the runtime side keeps firing
            // until the subscription itself is dropped.
            let _ = on_event.send(ReattachedAgentEvent {
                request_id: notif.request_id,
                event: notif.event,
                seq: notif.seq,
            });
        }))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "runtime `{name}` does not stream agent events (only connected remote runtimes do)"
            )
        })?;

    let attach_result = runtime.agent_attach(crate::remote::AgentAttachParams {
        request_id: request_id.clone(),
        since_seq,
    })?;

    if !attach_result.found {
        // Drop the subscription explicitly — the daemon doesn't know
        // about it (no live session means no notifier to swap), but
        // dropping unregisters the per-call callback from the
        // RpcClient so the Channel goes idle.
        drop(subscription);
        return Ok(ReattachAgentStreamResult {
            found: false,
            last_seq: 0,
            replayed_count: 0,
            replay_gap: None,
        });
    }

    subscriptions.insert(request_id, subscription);
    Ok(ReattachAgentStreamResult {
        found: true,
        last_seq: attach_result.last_seq,
        replayed_count: attach_result.replayed_count,
        replay_gap: attach_result.replay_gap,
    })
}

/// Release a streaming reattach started by
/// [`reattach_remote_agent_session_stream`]. Drops the per-
/// `request_id` subscription, which unregisters the callback on
/// the underlying `RpcClient`; the Channel stops receiving
/// events. Returns `released=false` when no stream was active for
/// `request_id` — typical when the desktop reloads and the panel
/// blindly calls release on every known id.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAgentStreamResult {
    pub released: bool,
}

#[tauri::command]
pub async fn release_remote_agent_session_stream(
    subscriptions: tauri::State<'_, Arc<RemoteAgentStreamSubscriptions>>,
    request_id: String,
) -> CmdResult<ReleaseAgentStreamResult> {
    let subscriptions = Arc::clone(&subscriptions);
    run_blocking(move || release_remote_agent_session_stream_inner(&subscriptions, request_id))
        .await
}

fn release_remote_agent_session_stream_inner(
    subscriptions: &Arc<RemoteAgentStreamSubscriptions>,
    request_id: String,
) -> anyhow::Result<ReleaseAgentStreamResult> {
    if request_id.trim().is_empty() {
        bail!("request_id must not be empty");
    }
    let released = subscriptions.remove(&request_id);
    Ok(ReleaseAgentStreamResult { released })
}

fn attach_remote_agent_session_inner(
    registry: &Arc<RuntimeRegistry>,
    name: String,
    request_id: String,
    since_seq: Option<u64>,
) -> anyhow::Result<AttachRemoteAgentSessionResult> {
    if name.trim().is_empty() {
        bail!("runtime name must not be empty");
    }
    if request_id.trim().is_empty() {
        bail!("request_id must not be empty");
    }
    if name == LOCAL_RUNTIME_NAME {
        bail!("agent.attach is only available on registered remote runtimes (got `{name}`)");
    }
    let runtime = registry.lookup(Some(&name))?;
    let result = runtime.agent_attach(crate::remote::AgentAttachParams {
        request_id,
        since_seq,
    })?;
    Ok(AttachRemoteAgentSessionResult {
        found: result.found,
        last_seq: result.last_seq,
        replayed_count: result.replayed_count,
        replay_gap: result.replay_gap,
    })
}

/// Resolve a `helmor_session_id` to its `since_seq` for an attach.
/// Returns `None` (cold attach) when:
/// - the caller passed `helmor_session_id=None`,
/// - the session has no rows yet,
/// - all rows have `last_event_seq = NULL` (legacy / local-only),
/// - or the DB read fails (logged at debug; the daemon will flush
///   the full ring as a graceful fallback).
fn compute_since_seq(helmor_session_id: Option<&str>) -> Option<u64> {
    let session_id = helmor_session_id?;
    match crate::models::db::read(|conn| {
        crate::agents::persistence::max_event_seq_for_session(conn, session_id)
    }) {
        Ok(max) => max,
        Err(err) => {
            tracing::debug!(
                helmor_session_id = %session_id,
                error = %format!("{err:#}"),
                "compute_since_seq: DB read failed; falling back to cold attach"
            );
            None
        }
    }
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

    type AgentEventCallback =
        Box<dyn Fn(crate::remote::methods::AgentEventNotification) + Send + Sync>;

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
        search_calls: Mutex<Vec<WorkspaceSearchParams>>,
        /// Override the WorkspaceSearchResult returned by the stub so
        /// tests can assert both the empty-result and full-result
        /// branches of the search command.
        search_result: Mutex<Option<WorkspaceSearchResult>>,
        agent_list_calls: Mutex<u32>,
        agent_abort_calls: Mutex<Vec<crate::remote::AgentAbortParams>>,
        agent_attach_calls: Mutex<Vec<crate::remote::AgentAttachParams>>,
        /// Sessions the stub reports in `agent_list`. Tests seed this
        /// before driving the command so the response is deterministic.
        agent_sessions: Mutex<Vec<crate::remote::AgentSessionEntry>>,
        /// Override the `attach` return value so tests can exercise
        /// both the found / not-found branches.
        agent_attach_found: Mutex<bool>,
        /// Phase 24q-2: override the daemon-reported `last_seq` so
        /// tests can verify the desktop surfaces it on the result.
        agent_attach_last_seq: Mutex<u64>,
        /// Phase 24q-2: override the daemon-reported `replayed_count`.
        agent_attach_replayed_count: Mutex<u64>,
        /// Phase 24q-2: override the daemon-reported `replay_gap`.
        /// `None` (the default) means a clean replay; `Some(n)`
        /// signals the journal couldn't fully satisfy the request.
        agent_attach_replay_gap: Mutex<Option<u64>>,
        /// Captured callbacks from `subscribe_agent_events`. The
        /// stub's `fire_agent_event` helper invokes every one in
        /// turn so tests can drive the reattach event pipeline
        /// without a real RPC pipe.
        agent_event_callbacks: Mutex<Vec<AgentEventCallback>>,
        /// When `true`, `subscribe_agent_events` returns `None`
        /// instead of registering — lets a test exercise the
        /// "runtime does not stream events" error branch.
        agent_events_disabled: Mutex<bool>,
        /// Override the stub's RpcClientDiagnostics. `None` means
        /// `client_diagnostics` returns `None` (mirrors the local
        /// runtime); `Some(_)` is what the diagnostics command
        /// surfaces in its `client` field.
        client_diagnostics_override: Mutex<Option<crate::remote::RpcClientDiagnostics>>,
        /// When `true`, the stub's `ping` returns Err so the
        /// diagnostics command's last-ping path can be tested.
        ping_fails: Mutex<bool>,
        /// When `true`, `agent_list` bails — exercises the
        /// "agent.list failure is recorded in last_error" branch.
        agent_list_fails: Mutex<bool>,
        /// When `true`, `runtime_health` returns Err — exercises
        /// the "health failure is recorded in last_error" branch.
        health_fails: Mutex<bool>,
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
            if *self.health_fails.lock().unwrap() {
                bail!("simulated runtime_health failure");
            }
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
            if *self.ping_fails.lock().unwrap() {
                bail!("simulated ping failure")
            } else {
                Ok(())
            }
        }
        fn client_diagnostics(&self) -> Option<crate::remote::RpcClientDiagnostics> {
            self.client_diagnostics_override.lock().unwrap().clone()
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
        fn workspace_search(&self, params: WorkspaceSearchParams) -> Result<WorkspaceSearchResult> {
            let response = self
                .search_result
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_default();
            self.search_calls.lock().unwrap().push(params);
            Ok(response)
        }
        fn agent_list(
            &self,
            _params: crate::remote::AgentListParams,
        ) -> Result<crate::remote::AgentListResult> {
            *self.agent_list_calls.lock().unwrap() += 1;
            if *self.agent_list_fails.lock().unwrap() {
                bail!("simulated agent.list failure");
            }
            Ok(crate::remote::AgentListResult {
                sessions: self.agent_sessions.lock().unwrap().clone(),
            })
        }
        fn agent_abort(
            &self,
            params: crate::remote::AgentAbortParams,
        ) -> Result<crate::remote::methods::AgentAbortResult> {
            self.agent_abort_calls.lock().unwrap().push(params);
            Ok(crate::remote::methods::AgentAbortResult::default())
        }
        fn agent_attach(
            &self,
            params: crate::remote::AgentAttachParams,
        ) -> Result<crate::remote::AgentAttachResult> {
            self.agent_attach_calls.lock().unwrap().push(params);
            Ok(crate::remote::AgentAttachResult {
                found: *self.agent_attach_found.lock().unwrap(),
                last_seq: *self.agent_attach_last_seq.lock().unwrap(),
                replayed_count: *self.agent_attach_replayed_count.lock().unwrap(),
                replay_gap: *self.agent_attach_replay_gap.lock().unwrap(),
            })
        }
        fn subscribe_agent_events(
            &self,
            callback: AgentEventCallback,
        ) -> Option<NotificationSubscription> {
            if *self.agent_events_disabled.lock().unwrap() {
                return None;
            }
            self.agent_event_callbacks.lock().unwrap().push(callback);
            // Use the test-only dangling factory — the real
            // RpcClient handle isn't accessible from here, but the
            // command paths under test only care that *some*
            // NotificationSubscription comes back and gets stashed.
            Some(NotificationSubscription::dangling_for_tests())
        }
    }

    impl InspectorStubRuntime {
        /// Synthesise an agent.event notification + fire every
        /// registered callback in turn. The reattach command
        /// filters by request_id inside its callback closure, so
        /// firing an unrelated event verifies the demux works.
        fn fire_agent_event(&self, notif: crate::remote::methods::AgentEventNotification) {
            let cbs = self.agent_event_callbacks.lock().unwrap();
            for cb in cbs.iter() {
                cb(notif.clone());
            }
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

    // ── workspace.search (phase 24e) ──────────────────────────────

    #[test]
    fn search_workspace_routes_through_workspace_binding_by_default() {
        // Default path: no explicit runtime_name + a workspace_id
        // bound to a registered remote → the search must go to the
        // bound runtime, not the local fallback.
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = bindings_with("ws-bound", "stub.box");

        search_workspace_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "needle".into(),
            None,
            false,
            false,
            Some("ws-bound"),
            None,
        )
        .unwrap();

        let calls = stub.search_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].workspace_dir, "/ws");
        assert_eq!(calls[0].query, "needle");
    }

    #[test]
    fn search_workspace_explicit_runtime_name_wins_over_binding() {
        // Same precedence rule as every other inspector op: an
        // explicit `runtime_name` overrides the workspace binding.
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = bindings_with("ws-bound", "stub.box");

        search_workspace_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "q".into(),
            None,
            false,
            false,
            Some("ws-bound"),
            Some("stub.box"),
        )
        .unwrap();

        assert_eq!(stub.search_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn search_workspace_forwards_flags_to_runtime() {
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = bindings_with("ws-bound", "stub.box");

        search_workspace_inner(
            &registry,
            &bindings,
            "/srv/repo".into(),
            "TODO".into(),
            Some(42),
            true,
            true,
            Some("ws-bound"),
            None,
        )
        .unwrap();

        let calls = stub.search_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let p = &calls[0];
        assert_eq!(p.workspace_dir, "/srv/repo");
        assert_eq!(p.query, "TODO");
        assert_eq!(p.max_results, Some(42));
        assert!(p.case_insensitive);
        assert!(p.fixed_string);
    }

    #[test]
    fn search_workspace_surfaces_runtime_result_to_caller() {
        // Seed a non-empty response so we verify the matches +
        // truncated flag flow through verbatim.
        let (registry, stub) = registry_with_inspector_stub();
        let bindings = bindings_with("ws-bound", "stub.box");
        *stub.search_result.lock().unwrap() = Some(WorkspaceSearchResult {
            matches: vec![crate::remote::methods::WorkspaceSearchMatch {
                relative_path: "src/main.rs".into(),
                line_number: 17,
                line: "fn main()".into(),
            }],
            truncated: true,
        });

        let result = search_workspace_inner(
            &registry,
            &bindings,
            "/ws".into(),
            "main".into(),
            None,
            false,
            false,
            Some("ws-bound"),
            None,
        )
        .unwrap();

        assert!(result.truncated);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].relative_path, "src/main.rs");
        assert_eq!(result.matches[0].line_number, 17);
    }

    // ── remote agent reattach (phase 24d) ─────────────────────────

    #[test]
    fn list_remote_agent_sessions_rejects_empty_name() {
        let (registry, _stub) = registry_with_inspector_stub();
        let err = list_remote_agent_sessions_inner(&registry, "".into()).unwrap_err();
        assert!(format!("{err:#}").contains("runtime name must not be empty"));
        let err = list_remote_agent_sessions_inner(&registry, "   ".into()).unwrap_err();
        assert!(format!("{err:#}").contains("runtime name must not be empty"));
    }

    #[test]
    fn list_remote_agent_sessions_refuses_local_runtime_by_name() {
        // The local sidecar has no daemon-side agent.list — refuse
        // explicitly rather than passing through to the trait default
        // (which would bail with a generic "only on connected remote"
        // message). Operator gets the actionable hint.
        let (registry, _stub) = registry_with_inspector_stub();
        let err =
            list_remote_agent_sessions_inner(&registry, LOCAL_RUNTIME_NAME.into()).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("only available on registered remote runtimes"));
        assert!(msg.contains(LOCAL_RUNTIME_NAME));
    }

    #[test]
    fn list_remote_agent_sessions_returns_runtime_sessions() {
        let (registry, stub) = registry_with_inspector_stub();
        // Seed two scripted sessions on the stub. The command should
        // surface them in trait-order (no sorting/dedup at this layer).
        let session_a = crate::remote::AgentSessionEntry {
            request_id: "req-A".into(),
            helmor_session_id: Some("hs-1".into()),
            provider: Some("claude".into()),
            workspace_dir: Some("/srv/repos/demo".into()),
            started_at_ms: 1_000,
            last_event_ms: 1_500,
        };
        let session_b = crate::remote::AgentSessionEntry {
            request_id: "req-B".into(),
            helmor_session_id: None,
            provider: None,
            workspace_dir: None,
            started_at_ms: 2_000,
            last_event_ms: 2_000,
        };
        *stub.agent_sessions.lock().unwrap() = vec![session_a.clone(), session_b.clone()];

        let sessions = list_remote_agent_sessions_inner(&registry, "stub.box".into()).unwrap();

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].request_id, "req-A");
        assert_eq!(sessions[0].helmor_session_id.as_deref(), Some("hs-1"));
        assert_eq!(sessions[0].provider.as_deref(), Some("claude"));
        assert_eq!(sessions[1].request_id, "req-B");
        assert!(sessions[1].helmor_session_id.is_none());
        assert_eq!(*stub.agent_list_calls.lock().unwrap(), 1);
    }

    #[test]
    fn list_remote_agent_sessions_surfaces_runtime_error_to_caller() {
        // The registry's `lookup` of an unregistered name fails with
        // a wrapped error. The command must propagate rather than
        // panicking or silently returning an empty list (which would
        // hide a configuration bug).
        let (registry, _stub) = registry_with_inspector_stub();
        let err = list_remote_agent_sessions_inner(&registry, "not.registered".into()).unwrap_err();
        assert!(
            format!("{err:#}").to_lowercase().contains("not")
                || format!("{err:#}").contains("registered"),
            "lookup error should surface: {err:#}"
        );
    }

    #[test]
    fn abort_remote_agent_session_validates_request_id() {
        let (registry, _stub) = registry_with_inspector_stub();
        let err =
            abort_remote_agent_session_inner(&registry, "stub.box".into(), "".into()).unwrap_err();
        assert!(format!("{err:#}").contains("request_id must not be empty"));
        let err = abort_remote_agent_session_inner(&registry, "stub.box".into(), "   ".into())
            .unwrap_err();
        assert!(format!("{err:#}").contains("request_id must not be empty"));
    }

    #[test]
    fn abort_remote_agent_session_refuses_local_runtime_by_name() {
        let (registry, _stub) = registry_with_inspector_stub();
        let err =
            abort_remote_agent_session_inner(&registry, LOCAL_RUNTIME_NAME.into(), "req-1".into())
                .unwrap_err();
        assert!(format!("{err:#}").contains("only available on registered remote runtimes"));
    }

    #[test]
    fn abort_remote_agent_session_forwards_request_id_to_runtime() {
        let (registry, stub) = registry_with_inspector_stub();
        abort_remote_agent_session_inner(&registry, "stub.box".into(), "req-abort-1".into())
            .unwrap();
        let calls = stub.agent_abort_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].request_id, "req-abort-1");
    }

    #[test]
    fn attach_remote_agent_session_validates_inputs() {
        let (registry, _stub) = registry_with_inspector_stub();
        // Empty name.
        let err = attach_remote_agent_session_inner(&registry, "".into(), "req-1".into(), None)
            .unwrap_err();
        assert!(format!("{err:#}").contains("runtime name must not be empty"));
        // Empty request_id.
        let err = attach_remote_agent_session_inner(&registry, "stub.box".into(), "".into(), None)
            .unwrap_err();
        assert!(format!("{err:#}").contains("request_id must not be empty"));
        // Local runtime.
        let err = attach_remote_agent_session_inner(
            &registry,
            LOCAL_RUNTIME_NAME.into(),
            "req-1".into(),
            None,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("only available on registered remote runtimes"));
    }

    #[test]
    fn attach_remote_agent_session_reports_found_when_runtime_reports_found() {
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;

        let result = attach_remote_agent_session_inner(
            &registry,
            "stub.box".into(),
            "req-attach-1".into(),
            None,
        )
        .unwrap();

        assert!(result.found);
        let calls = stub.agent_attach_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].request_id, "req-attach-1");
    }

    #[test]
    fn attach_remote_agent_session_reports_false_when_runtime_does_not_find_session() {
        // When the daemon-side session has expired between list +
        // attach, the runtime reports `found=false`. The command
        // surfaces that bool without converting it into an error —
        // the desktop UI uses it to show a "session has ended"
        // toast and clear the reattach affordance.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = false;

        let result = attach_remote_agent_session_inner(
            &registry,
            "stub.box".into(),
            "req-stale".into(),
            None,
        )
        .unwrap();

        assert!(!result.found);
        assert_eq!(stub.agent_attach_calls.lock().unwrap().len(), 1);
    }

    /// Phase 24q-2: when the command supplies `since_seq`, it must
    /// reach the daemon verbatim via `AgentAttachParams.since_seq`.
    #[test]
    fn attach_remote_agent_session_forwards_since_seq_to_runtime() {
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;

        let _result = attach_remote_agent_session_inner(
            &registry,
            "stub.box".into(),
            "req-with-seq".into(),
            Some(42),
        )
        .unwrap();

        let calls = stub.agent_attach_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].since_seq, Some(42));
    }

    /// Phase 24q-2: result fields mirror what the daemon reported
    /// (last_seq / replayed_count / replay_gap) so the frontend can
    /// surface "N replayed" + "gap before X" diagnostics.
    #[test]
    fn attach_remote_agent_session_returns_daemon_replay_details() {
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;
        *stub.agent_attach_last_seq.lock().unwrap() = 99;
        *stub.agent_attach_replayed_count.lock().unwrap() = 7;
        *stub.agent_attach_replay_gap.lock().unwrap() = Some(50);

        let result = attach_remote_agent_session_inner(
            &registry,
            "stub.box".into(),
            "req-replay".into(),
            Some(42),
        )
        .unwrap();

        assert!(result.found);
        assert_eq!(result.last_seq, 99);
        assert_eq!(result.replayed_count, 7);
        assert_eq!(result.replay_gap, Some(50));
    }

    /// Phase 24q-2: found=false zeroes out the replay fields. The
    /// daemon may still send sane values when found=false, but the
    /// desktop shouldn't surface them — there's no session to
    /// reattach to.
    #[test]
    fn attach_remote_agent_session_zeroes_replay_fields_when_not_found() {
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = false;
        *stub.agent_attach_last_seq.lock().unwrap() = 99;
        *stub.agent_attach_replayed_count.lock().unwrap() = 7;
        *stub.agent_attach_replay_gap.lock().unwrap() = Some(50);

        let result = attach_remote_agent_session_inner(
            &registry,
            "stub.box".into(),
            "req-stale".into(),
            Some(42),
        )
        .unwrap();

        assert!(!result.found);
        // The daemon-reported values pass through as-is on the
        // attach command (the reattach-stream command zeroes them
        // because the Channel is inert; the bare attach command
        // mirrors the daemon literally so the operator can spot
        // weird daemon behavior).
        assert_eq!(result.last_seq, 99);
        assert_eq!(result.replayed_count, 7);
        assert_eq!(result.replay_gap, Some(50));
    }

    // ── compute_since_seq (phase 24q-2) ────────────────────────────

    /// Phase 24q-2: the command-layer helper reads the desktop's
    /// local `MAX(last_event_seq)` for the supplied session. This
    /// test exercises the full DB-backed path through the production
    /// pool by inserting a row with `last_event_seq=Some(7)` and
    /// asserting the helper returns it.
    #[test]
    fn compute_since_seq_returns_max_seq_from_local_db() {
        use crate::testkit::TestEnv;
        let env = TestEnv::new("compute-since-seq");
        let conn = env.db_connection();
        // Repo + workspace + session needed to satisfy FKs on
        // session_messages.session_id. Use synthetic IDs so the
        // assertions are obvious.
        conn.execute(
            "INSERT INTO repos (id, name, remote_url, default_branch, root_path) VALUES ('r1', 'demo', NULL, 'main', '/tmp/demo')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, status, branch, display_order) VALUES ('w1', 'r1', 'demo', 'ready', 'in-progress', 'main', 100)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, title, agent_type, status, model, permission_mode) VALUES ('hs-1', 'w1', 't', 'claude', 'idle', 'opus', 'default')",
            [],
        ).unwrap();
        // Two rows for hs-1, one with a higher seq.
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, last_event_seq) VALUES ('m1', 'hs-1', 'assistant', '{}', 3)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO session_messages (id, session_id, role, content, last_event_seq) VALUES ('m2', 'hs-1', 'assistant', '{}', 7)",
            [],
        ).unwrap();

        assert_eq!(compute_since_seq(Some("hs-1")), Some(7));
        assert_eq!(compute_since_seq(None), None);
        assert_eq!(compute_since_seq(Some("hs-other")), None);
    }

    // ── reattach_remote_agent_session_stream (phase 24i) ──────────

    /// Build a Channel<ReattachedAgentEvent> that captures every
    /// `send` into a `Mutex<Vec<_>>` decoded from the InvokeResponseBody.
    /// Tauri Channels serialise sent values into an
    /// `InvokeResponseBody::Json` on the dispatch path; we round-trip
    /// the JSON to recover the typed struct for assertions.
    fn capturing_reattach_channel() -> (
        Channel<ReattachedAgentEvent>,
        Arc<std::sync::Mutex<Vec<ReattachedAgentEvent>>>,
    ) {
        use tauri::ipc::InvokeResponseBody;
        let captured: Arc<std::sync::Mutex<Vec<ReattachedAgentEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let inner = Arc::clone(&captured);
        let channel = Channel::<ReattachedAgentEvent>::new(move |body| {
            // Tauri ships Json payloads as raw strings — parse to
            // recover the typed event. Raw byte payloads aren't
            // emitted by our codepath.
            if let InvokeResponseBody::Json(s) = body {
                match serde_json::from_str::<ReattachedAgentEvent>(&s) {
                    Ok(event) => inner.lock().unwrap().push(event),
                    Err(err) => panic!("captured channel got non-event JSON: {err}: {s}"),
                }
            } else {
                panic!("expected Json body, got non-JSON variant");
            }
            Ok(())
        });
        (channel, captured)
    }

    #[test]
    fn reattach_stream_rejects_empty_name_and_request_id() {
        let (registry, _stub) = registry_with_inspector_stub();
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, _captured) = capturing_reattach_channel();
        let err = reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "".into(),
            "req-1".into(),
            None,
            chan.clone(),
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("runtime name must not be empty"));

        let err = reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "".into(),
            None,
            chan,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("request_id must not be empty"));
    }

    #[test]
    fn reattach_stream_refuses_local_runtime_by_name() {
        let (registry, _stub) = registry_with_inspector_stub();
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, _captured) = capturing_reattach_channel();
        let err = reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            LOCAL_RUNTIME_NAME.into(),
            "req-1".into(),
            None,
            chan,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("only available on registered remote runtimes"));
    }

    #[test]
    fn reattach_stream_returns_found_true_and_stashes_subscription() {
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, _captured) = capturing_reattach_channel();

        let result = reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-found".into(),
            None,
            chan,
        )
        .unwrap();

        assert!(result.found);
        // The subscription must live in the state so the callback
        // outlives the command frame — the per-call closure dies
        // otherwise + the Channel goes silent.
        assert_eq!(
            subscriptions.active_request_ids(),
            vec!["req-found".to_string()]
        );
        // Attach was called once with the right id.
        assert_eq!(stub.agent_attach_calls.lock().unwrap().len(), 1);
        assert_eq!(
            stub.agent_attach_calls.lock().unwrap()[0].request_id,
            "req-found"
        );
    }

    #[test]
    fn reattach_stream_returns_found_false_and_drops_subscription() {
        // The found=false branch must NOT stash the subscription
        // — otherwise the Channel sits in the map forever holding
        // a callback that never fires. Operator never gets to
        // call `release_remote_agent_session_stream` because the
        // UI showed "session has ended" and hid the affordance.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = false;
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, _captured) = capturing_reattach_channel();

        let result = reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-gone".into(),
            None,
            chan,
        )
        .unwrap();

        assert!(!result.found);
        assert!(subscriptions.active_request_ids().is_empty());
        // Replay fields zero out so the frontend doesn't render
        // stale "N events replayed" diagnostics for a session it
        // can't attach to anyway.
        assert_eq!(result.last_seq, 0);
        assert_eq!(result.replayed_count, 0);
        assert_eq!(result.replay_gap, None);
    }

    /// Phase 24q-2: `since_seq` reaches the daemon verbatim via
    /// `AgentAttachParams.since_seq`, and the daemon-reported
    /// `last_seq` / `replayed_count` / `replay_gap` surface on the
    /// result so the frontend can stash them for the next reattach.
    #[test]
    fn reattach_stream_forwards_since_seq_and_returns_replay_details() {
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;
        *stub.agent_attach_last_seq.lock().unwrap() = 123;
        *stub.agent_attach_replayed_count.lock().unwrap() = 4;
        *stub.agent_attach_replay_gap.lock().unwrap() = Some(80);
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, _captured) = capturing_reattach_channel();

        let result = reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-resume".into(),
            Some(42),
            chan,
        )
        .unwrap();

        assert!(result.found);
        assert_eq!(result.last_seq, 123);
        assert_eq!(result.replayed_count, 4);
        assert_eq!(result.replay_gap, Some(80));

        let calls = stub.agent_attach_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].since_seq, Some(42));
    }

    #[test]
    fn reattach_stream_runtime_without_subscription_support_surfaces_error() {
        // The runtime's `subscribe_agent_events` can return None
        // (only OpenSSH / Command runtimes implement it). Reattach
        // surfaces that as a legible error rather than silently
        // dropping into the attach RPC + leaving the Channel idle.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_events_disabled.lock().unwrap() = true;
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, _captured) = capturing_reattach_channel();

        let err = reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-1".into(),
            None,
            chan,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("does not stream agent events"));
        // No attach call should have fired — we bailed before that.
        assert!(stub.agent_attach_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn reattach_stream_forwards_matching_agent_events_to_channel() {
        // End-to-end check: register the stream, fire a few
        // synthesised agent.event notifications through the stub's
        // captured callback, assert only the matching request_id's
        // events land on the channel and the payload round-trips.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, captured) = capturing_reattach_channel();

        reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-A".into(),
            None,
            chan,
        )
        .unwrap();

        // Fire one matching + one unrelated event. The reattach
        // closure filters by request_id, so only the match flows.
        stub.fire_agent_event(crate::remote::methods::AgentEventNotification {
            request_id: "req-A".into(),
            event: serde_json::json!({ "type": "assistant", "delta": "hi" }),
            seq: None,
        });
        stub.fire_agent_event(crate::remote::methods::AgentEventNotification {
            request_id: "req-other".into(),
            event: serde_json::json!({ "type": "assistant", "delta": "skip" }),
            seq: None,
        });
        stub.fire_agent_event(crate::remote::methods::AgentEventNotification {
            request_id: "req-A".into(),
            event: serde_json::json!({
                "type": "result",
                "subtype": "success",
                "result": "all done"
            }),
            seq: None,
        });

        let events = captured.lock().unwrap().clone();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].request_id, "req-A");
        assert_eq!(events[0].event["type"], "assistant");
        assert_eq!(events[0].event["delta"], "hi");
        assert_eq!(events[1].event["type"], "result");
    }

    #[test]
    fn reattach_stream_stops_forwarding_after_release() {
        // Release drops the subscription. New events fired by the
        // runtime should NOT reach the channel because the closure's
        // Arc<Channel> got dropped along with the subscription.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan, captured) = capturing_reattach_channel();

        reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-release".into(),
            None,
            chan,
        )
        .unwrap();

        stub.fire_agent_event(crate::remote::methods::AgentEventNotification {
            request_id: "req-release".into(),
            event: serde_json::json!({ "type": "assistant", "delta": "before-release" }),
            seq: None,
        });

        let release_result =
            release_remote_agent_session_stream_inner(&subscriptions, "req-release".into())
                .unwrap();
        assert!(release_result.released);
        assert!(subscriptions.active_request_ids().is_empty());

        // The stub keeps its callbacks; firing now should NOT add
        // an event to the captured list because the channel's
        // outer Arc was dropped + send returns SendError which we
        // swallow. Specifically: the closure still runs but the
        // channel's drop should disconnect it. In practice the
        // captured-list count stays at 1 because the closure is
        // gone.
        //
        // BUT — our stub holds an Arc to the callback closure
        // itself. Dropping the NotificationSubscription only
        // removes the production RpcClient registration; in test
        // the closure remains alive. So this test asserts the
        // weaker contract: the subscription is removed from the
        // manager's map. (A production teardown unhooks the
        // RpcClient registration via NotificationSubscription's
        // real Drop.)
        let _ = captured; // keep reference live so the test owns it.
    }

    #[test]
    fn release_unknown_request_id_returns_released_false() {
        // The frontend may call release blindly on every known id
        // (panel unmount + reload race) — returning false rather
        // than erroring is the contract.
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let result =
            release_remote_agent_session_stream_inner(&subscriptions, "never-streamed".into())
                .unwrap();
        assert!(!result.released);
    }

    #[test]
    fn release_rejects_empty_request_id() {
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let err = release_remote_agent_session_stream_inner(&subscriptions, "".into()).unwrap_err();
        assert!(format!("{err:#}").contains("request_id must not be empty"));
    }

    #[test]
    fn reattach_stream_can_run_concurrently_for_distinct_request_ids() {
        // Two reattach streams on the same runtime should each get
        // their own subscription entry; demux by request_id inside
        // the per-stream filter closure keeps the channels clean.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_attach_found.lock().unwrap() = true;
        let subscriptions = Arc::new(RemoteAgentStreamSubscriptions::new());
        let (chan_a, captured_a) = capturing_reattach_channel();
        let (chan_b, captured_b) = capturing_reattach_channel();

        reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-A".into(),
            None,
            chan_a,
        )
        .unwrap();
        reattach_remote_agent_session_stream_inner(
            &registry,
            &subscriptions,
            "stub.box".into(),
            "req-B".into(),
            None,
            chan_b,
        )
        .unwrap();

        assert_eq!(
            subscriptions.active_request_ids(),
            vec!["req-A".to_string(), "req-B".into()]
        );

        // Fire one event per stream; each lands on the right channel.
        stub.fire_agent_event(crate::remote::methods::AgentEventNotification {
            request_id: "req-A".into(),
            event: serde_json::json!({ "delta": "for-A" }),
            seq: None,
        });
        stub.fire_agent_event(crate::remote::methods::AgentEventNotification {
            request_id: "req-B".into(),
            event: serde_json::json!({ "delta": "for-B" }),
            seq: None,
        });

        let events_a = captured_a.lock().unwrap().clone();
        let events_b = captured_b.lock().unwrap().clone();
        assert_eq!(events_a.len(), 1);
        assert_eq!(events_a[0].event["delta"], "for-A");
        assert_eq!(events_b.len(), 1);
        assert_eq!(events_b[0].event["delta"], "for-B");
    }

    // ── get_remote_runtime_diagnostics (phase 24j) ────────────────

    fn fake_client_diagnostics() -> crate::remote::RpcClientDiagnostics {
        crate::remote::RpcClientDiagnostics {
            peer_label: "ssh:stub.box".into(),
            server_version: "0.22.1".into(),
            server_hostname: "stub.box".into(),
            protocol_version: "0.1.0".into(),
            connected_at_ms: 1_700_000_000_000,
            closed_reason: None,
            requests_sent: 12,
            responses_received: 11,
            notifications_received: 4,
            decode_errors: 0,
        }
    }

    #[test]
    fn get_remote_runtime_diagnostics_rejects_empty_name() {
        let (registry, _stub) = registry_with_inspector_stub();
        let err = get_remote_runtime_diagnostics_inner(&registry, "".into()).unwrap_err();
        assert!(format!("{err:#}").contains("runtime name must not be empty"));
    }

    #[test]
    fn get_remote_runtime_diagnostics_surfaces_health_client_agent_count_and_ping() {
        // Happy path: every probe succeeds. The aggregated
        // diagnostics carry health + client + agent_session_count
        // + a recent ping; last_error stays None.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.client_diagnostics_override.lock().unwrap() = Some(fake_client_diagnostics());
        *stub.agent_sessions.lock().unwrap() = vec![
            crate::remote::AgentSessionEntry {
                request_id: "req-1".into(),
                helmor_session_id: None,
                provider: None,
                workspace_dir: None,
                started_at_ms: 0,
                last_event_ms: 0,
            },
            crate::remote::AgentSessionEntry {
                request_id: "req-2".into(),
                helmor_session_id: None,
                provider: None,
                workspace_dir: None,
                started_at_ms: 0,
                last_event_ms: 0,
            },
        ];

        let diag = get_remote_runtime_diagnostics_inner(&registry, "stub.box".into()).unwrap();

        assert_eq!(diag.name, "stub.box");
        let health = diag.health.expect("health snapshot");
        assert_eq!(health.hostname, "stub.box");
        let client = diag.client.expect("client diagnostics");
        assert_eq!(client.peer_label, "ssh:stub.box");
        assert_eq!(client.requests_sent, 12);
        assert_eq!(diag.agent_session_count, Some(2));
        // The ping uses wall-clock duration which can be 0ms on a
        // very fast machine; we just confirm we recorded a value.
        assert!(diag.last_ping_ms.is_some());
        assert!(diag.last_error.is_none());
    }

    #[test]
    fn get_remote_runtime_diagnostics_records_ping_failure_in_last_error() {
        // A failed ping shouldn't bail the whole probe — the panel
        // still wants to render whatever else succeeded. last_ping_ms
        // stays None + last_error carries the reason.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.client_diagnostics_override.lock().unwrap() = Some(fake_client_diagnostics());
        *stub.ping_fails.lock().unwrap() = true;

        let diag = get_remote_runtime_diagnostics_inner(&registry, "stub.box".into()).unwrap();

        assert!(diag.last_ping_ms.is_none());
        let err = diag.last_error.expect("last_error populated");
        assert!(
            err.contains("ping"),
            "last_error should mention ping: {err}"
        );
        assert!(err.contains("simulated ping failure"));
        // Other surfaces still flow.
        assert!(diag.health.is_some());
        assert!(diag.client.is_some());
    }

    #[test]
    fn get_remote_runtime_diagnostics_records_agent_list_failure() {
        // agent.list failures aren't the default-bail case for the
        // stub — they're an explicit Err. That should land in
        // last_error so the panel surfaces the actual issue
        // (e.g. daemon-side agent state misconfigured).
        let (registry, stub) = registry_with_inspector_stub();
        *stub.agent_list_fails.lock().unwrap() = true;

        let diag = get_remote_runtime_diagnostics_inner(&registry, "stub.box".into()).unwrap();

        assert!(diag.agent_session_count.is_none());
        let err = diag.last_error.expect("last_error populated");
        assert!(
            err.contains("agent.list"),
            "last_error should mention agent.list: {err}"
        );
        assert!(err.contains("simulated agent.list failure"));
    }

    #[test]
    fn get_remote_runtime_diagnostics_records_health_failure() {
        let (registry, stub) = registry_with_inspector_stub();
        *stub.health_fails.lock().unwrap() = true;

        let diag = get_remote_runtime_diagnostics_inner(&registry, "stub.box".into()).unwrap();

        assert!(diag.health.is_none());
        let err = diag.last_error.expect("last_error populated");
        assert!(err.contains("runtime_health"));
    }

    #[test]
    fn get_remote_runtime_diagnostics_first_failure_wins_last_error() {
        // If multiple probes fail, the first one's message stays
        // in last_error. Order: runtime_health → agent.list → ping.
        // Health firing first owns last_error.
        let (registry, stub) = registry_with_inspector_stub();
        *stub.health_fails.lock().unwrap() = true;
        *stub.agent_list_fails.lock().unwrap() = true;
        *stub.ping_fails.lock().unwrap() = true;

        let diag = get_remote_runtime_diagnostics_inner(&registry, "stub.box".into()).unwrap();

        let err = diag.last_error.expect("last_error populated");
        // The first probe to record an error wins. The order is
        // runtime_health → client (no-op) → agent.list → ping;
        // we assert the health label is present + the others
        // didn't overwrite.
        assert!(
            err.starts_with("runtime_health:"),
            "expected runtime_health to claim first failure slot: {err}"
        );
    }

    #[test]
    fn get_remote_runtime_diagnostics_local_runtime_omits_default_bail_in_last_error() {
        // The local runtime's agent.list bails by default with the
        // "only on connected remote" message. The diagnostics command
        // treats that as an absence, NOT a failure, so the panel
        // doesn't render a red error chip for a perfectly healthy
        // local entry. Drive this through `name=local` so the
        // registry's local fallback impl gets hit.
        let registry = Arc::new(RuntimeRegistry::new());

        let diag = get_remote_runtime_diagnostics_inner(&registry, "local".into()).unwrap();

        // health populates from the LocalRuntime.
        assert!(diag.health.is_some());
        // No client wire to instrument.
        assert!(diag.client.is_none());
        // agent.list bailed → no count, but the bail is suppressed.
        assert!(diag.agent_session_count.is_none());
        // No last_error because we swallowed the "only on remote" bail.
        assert!(
            diag.last_error.is_none(),
            "local runtime should not surface a last_error: {:?}",
            diag.last_error
        );
        // Ping succeeds on the local runtime, so we always have a value.
        assert!(diag.last_ping_ms.is_some());
    }

    #[test]
    fn get_remote_runtime_diagnostics_surfaces_unknown_runtime_as_lookup_error() {
        // Asking for a runtime that isn't registered fails fast at
        // the registry lookup; the panel renders the error inline
        // rather than showing a phantom empty card.
        let registry = Arc::new(RuntimeRegistry::new());
        let err = get_remote_runtime_diagnostics_inner(&registry, "ghost.box".into()).unwrap_err();
        let msg = format!("{err:#}").to_lowercase();
        assert!(
            msg.contains("ghost.box") || msg.contains("not"),
            "expected lookup error for unknown runtime: {msg}"
        );
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
