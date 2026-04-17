//! Windows stub for the workspace script runner.
//!
//! The Unix implementation in `workspace/scripts.rs` uses POSIX PTY primitives
//! (`openpty`, `setsid`, `TIOCSCTTY`, `killpg`) that have no direct Windows
//! equivalent without pulling in ConPTY via `windows-sys`. To keep Windows
//! compiling in Phase 2 we expose the same public API surface with stub
//! implementations that emit a structured `ScriptEvent::Error` and return
//! early. Phase 6 replaces this with a real `cmd.exe`-backed piped-stdio
//! implementation (Job Object for descendant kill semantics).
//!
//! The API shape here MUST match the Unix module's public surface so the
//! rest of the codebase compiles on both targets unchanged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScriptEvent {
    Started { pid: u32, command: String },
    Stdout { data: String },
    Stderr { data: String },
    Exited { code: Option<i32> },
    Error { message: String },
}

/// Key = (repo_id, script_type, workspace_id). Public so the Unix and stub
/// modules expose the same alias.
type ProcessKey = (String, String, Option<String>);

/// Shell script process manager (Windows stub). The map is always empty
/// because `run_script` never spawns on Windows in the Phase 2 stub.
#[derive(Clone, Default)]
pub struct ScriptProcessManager {
    // Kept for API parity with the Unix impl. Stub never populates it.
    _processes: Arc<Mutex<HashMap<ProcessKey, ()>>>,
}

impl ScriptProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn kill(&self, _key: &ProcessKey) -> bool {
        // Nothing to kill — nothing was ever spawned.
        false
    }
}

/// Workspace context passed to scripts as environment variables. API parity
/// with the Unix module — Phase 6 will actually forward these as env vars.
pub struct ScriptContext {
    pub root_path: String,
    pub workspace_path: Option<String>,
    pub workspace_name: Option<String>,
    pub default_branch: Option<String>,
}

/// Phase 2 stub: emit a structured error event to the frontend explaining
/// that setup/run scripts are not yet available on Windows, and return
/// `Ok(None)` so callers don't treat it as a spawn failure. The frontend's
/// existing error handling on `ScriptEvent::Error` surfaces this as a
/// user-visible notice. Phase 6 replaces this with a real `cmd.exe /C`
/// pipe-backed implementation.
#[allow(clippy::too_many_arguments)]
pub fn run_script(
    _manager: &ScriptProcessManager,
    _repo_id: &str,
    _script_type: &str,
    _workspace_id: Option<&str>,
    _script: &str,
    _working_dir: &str,
    _context: &ScriptContext,
    channel: Channel<ScriptEvent>,
) -> Result<Option<i32>> {
    let _ = channel.send(ScriptEvent::Error {
        message: "Script execution is not yet supported on Windows. \
                  Planned for a future release (see docs/cross-platform.md). \
                  In the meantime, run the setup script manually in a terminal."
            .to_string(),
    });
    // Emit Exited so the frontend's lifecycle state machine settles instead of
    // waiting indefinitely for a completion event.
    let _ = channel.send(ScriptEvent::Exited { code: None });
    tracing::warn!(
        "run_script invoked on Windows — stub returned not-supported error \
         (Phase 2 stub; real impl lands in Phase 6)"
    );
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke-test the stub API surface. These tests only run on Windows.
    #[test]
    fn manager_new_does_not_panic() {
        let _ = ScriptProcessManager::new();
    }

    #[test]
    fn manager_kill_returns_false_when_key_absent() {
        let mgr = ScriptProcessManager::new();
        let key = ("repo".into(), "setup".into(), Some("ws".into()));
        assert!(!mgr.kill(&key));
    }

    #[test]
    fn script_event_serializes_camel_case() {
        let ev = ScriptEvent::Error {
            message: "test".into(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["message"], "test");
    }
}
