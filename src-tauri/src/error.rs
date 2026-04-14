//! Unified error type for Tauri commands.
//!
//! Internal functions use `anyhow::Result<T>` for ergonomic error propagation.
//! Tauri command handlers return `Result<T, CommandError>` — the `From` impl
//! automatically converts `anyhow::Error` into a serializable string for the
//! frontend.

use serde::Serialize;

/// Wrapper around `anyhow::Error` that implements `Serialize` for Tauri IPC.
///
/// The `{:#}` format renders the full context chain, e.g.:
/// "Failed to mark session as read: Failed to resolve workspace: no such table: sessions"
pub struct CommandError(anyhow::Error);

impl std::fmt::Debug for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.0)
    }
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("{:#}", self.0))
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(error: anyhow::Error) -> Self {
        let error_chain = format!("{error:#}");
        tracing::error!(error = %error_chain, error_debug = ?error, "Tauri command failed");
        CommandError(error)
    }
}
