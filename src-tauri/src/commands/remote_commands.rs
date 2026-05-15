//! Tauri command surface for the remote-runner trait seam.
//!
//! Today there is exactly one command — [`get_runtime_health`] —
//! and it always routes to the in-process [`crate::remote::LocalRuntime`].
//! It exists so the seam established in `src-tauri/src/remote/runtime.rs`
//! has a live IPC caller, not just unit tests. Once the SSH-backed
//! `RemoteRuntime` impl lands, the command will look up the runtime
//! for the active workspace instead of hard-coding the local one.

use crate::remote::{local_runtime, RuntimeHealth};

use super::common::CmdResult;

/// Probe the runtime currently bound to the host process. Cheap +
/// side-effect-free — safe to poll from the frontend on a focus tick
/// or to surface in a "connected to X" chip.
#[tauri::command]
pub fn get_runtime_health() -> CmdResult<RuntimeHealth> {
    Ok(local_runtime().runtime_health()?)
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
}
