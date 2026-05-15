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

use serde::{Deserialize, Serialize};

use crate::remote::{
    RemoteRuntime, RemoteSshRuntime, RuntimeHealth, RuntimeRegistry, WorkspaceStatusResult,
    LOCAL_RUNTIME_NAME,
};

use super::common::{run_blocking, CmdResult};

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
/// the runtime seam. Routes to the named runtime (defaults to local).
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
    workspace_dir: String,
    runtime_name: Option<String>,
) -> CmdResult<WorkspaceStatusResult> {
    let registry = Arc::clone(&registry);
    run_blocking(move || {
        let path = PathBuf::from(workspace_dir);
        let runtime = registry.lookup(runtime_name.as_deref())?;
        runtime.workspace_status(&path)
    })
    .await
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
        let runtime = RemoteSshRuntime::connect_ssh(&host, &remote_binary)?;
        let health = runtime.runtime_health()?;
        registry.register(name, Arc::new(runtime))?;
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
    Ok(())
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
            RuntimeEntry { name, is_local }
        })
        .collect())
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
    }

    fn registry_with_stub_remote() -> Arc<RuntimeRegistry> {
        let registry = Arc::new(RuntimeRegistry::new());
        registry
            .register(
                "stub.box",
                Arc::new(StubRuntime {
                    hostname: "stub.box",
                }),
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
                RuntimeEntry { name, is_local }
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
}
