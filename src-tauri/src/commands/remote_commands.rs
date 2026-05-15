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

use crate::remote::{
    RemoteRuntime, RemoteSshRuntime, RpcClient, RuntimeHealth, RuntimeRegistry,
    WorkspaceStatusResult, LOCAL_RUNTIME_NAME,
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
        let path = match binary_path {
            Some(p) => PathBuf::from(p),
            None => resolve_local_helmor_server_path()?,
        };
        let label = path.display().to_string();
        let cmd = std::process::Command::new(&path);
        let client = RpcClient::connect_command(cmd, label.clone())?;
        let runtime = RemoteSshRuntime::new(client, label);
        let health = runtime.runtime_health()?;
        registry.register(name, Arc::new(runtime))?;
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
}
