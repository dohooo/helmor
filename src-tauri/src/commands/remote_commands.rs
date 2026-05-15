//! Tauri command surface for the remote-runner trait seam.
//!
//! Today there is exactly one command — [`get_runtime_health`] —
//! and it always routes to the in-process [`crate::remote::LocalRuntime`].
//! It exists so the seam established in `src-tauri/src/remote/runtime.rs`
//! has a live IPC caller, not just unit tests. Once the SSH-backed
//! `RemoteRuntime` impl lands, the command will look up the runtime
//! for the active workspace instead of hard-coding the local one.

use std::path::PathBuf;

use crate::remote::{local_runtime, RuntimeHealth, WorkspaceStatusResult};

use super::common::{run_blocking, CmdResult};

/// Probe the runtime currently bound to the host process. Cheap +
/// side-effect-free — safe to poll from the frontend on a focus tick
/// or to surface in a "connected to X" chip.
#[tauri::command]
pub fn get_runtime_health() -> CmdResult<RuntimeHealth> {
    Ok(local_runtime().runtime_health()?)
}

/// Project the workspace's `git status --porcelain` output through
/// the runtime seam. Today this always hits the local runtime; once
/// per-workspace runtime routing lands, the lookup happens here.
///
/// `workspace_dir` is an absolute filesystem path. Runs on a blocking
/// thread because `git` is invoked synchronously and the porcelain
/// scan can take double-digit milliseconds on big repos.
#[tauri::command]
pub async fn get_workspace_status(workspace_dir: String) -> CmdResult<WorkspaceStatusResult> {
    run_blocking(move || {
        let path = PathBuf::from(workspace_dir);
        local_runtime().workspace_status(&path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::RuntimeKind;

    #[test]
    fn get_runtime_health_returns_local_kind_for_in_process_runtime() {
        // The command must never panic or return Err for the local
        // runtime — the frontend treats a failure here as "the app is
        // broken", so the bar is "always succeeds".
        let health = get_runtime_health().expect("local runtime should always report healthy");
        assert_eq!(health.kind, RuntimeKind::Local);
        assert!(!health.hostname.is_empty());
        assert!(!health.version.is_empty());
    }

    #[test]
    fn get_workspace_status_surfaces_runtime_errors_as_command_errors() {
        // A path that isn't a git repo should produce a CommandError,
        // not a panic. The exact message isn't pinned because git's
        // wording can vary across versions; we just assert "failed".
        let result = tauri::async_runtime::block_on(get_workspace_status(
            "/nonexistent-helmor-workspace-x9z".into(),
        ));
        assert!(
            result.is_err(),
            "non-repo path should surface as an Err: {result:?}"
        );
    }
}
