//! Typed error surface for Tauri commands.
//!
//! Internal code keeps using `anyhow::Result<T>`. At the IPC boundary,
//! `CommandError` serialises as `{ code, message }` — the frontend reads
//! `code` to drive recovery UX (e.g. offer "Permanently Delete" when a
//! workspace is broken) and `message` for display.
//!
//! Attach a code to an error via [`coded`] / [`bail_coded!`] / [`AnyhowCodedExt::with_code`].
//! Codes survive `.context(...)` wrapping because they ride inside the
//! anyhow chain as a [`CodedError`] layer that serialisation downcasts out.

use std::error::Error as StdError;
use std::fmt;

use serde::Serialize;

/// Discriminator the frontend uses to pick recovery UX. Extend on demand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    Unknown,
    /// Workspace is unusable at the filesystem/git layer — purge from DB to recover.
    WorkspaceBroken,
    /// Workspace row not in DB.
    WorkspaceNotFound,
    /// Expected forge CLI onboarding state: CLI missing or auth required.
    ForgeOnboarding,
}

/// Exposes an [`ErrorCode`] as a distinct layer in an anyhow error chain,
/// so `Error::chain()` + `downcast_ref` can locate it. Using our own
/// `StdError` wrapper (rather than `.context(marker)`) is necessary because
/// anyhow's `ContextError` hides the context value from `source()`, which
/// `.chain()` walks.
#[derive(Debug)]
pub struct CodedError {
    code: ErrorCode,
    source: Option<Box<dyn StdError + Send + Sync + 'static>>,
}

impl CodedError {
    pub fn code(&self) -> ErrorCode {
        self.code
    }
}

impl fmt::Display for CodedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Stripped from user-facing message at serialize time.
        write!(f, "{:?}", self.code)
    }
}

impl StdError for CodedError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.source
            .as_deref()
            .map(|e| e as &(dyn StdError + 'static))
    }
}

/// Build a fresh coded anyhow error. Chain `.context(...)` for the human message.
pub fn coded(code: ErrorCode) -> anyhow::Error {
    anyhow::Error::new(CodedError { code, source: None })
}

pub trait AnyhowCodedExt {
    /// Attach a code to an existing anyhow error without losing prior context.
    fn with_code(self, code: ErrorCode) -> anyhow::Error;
}

impl AnyhowCodedExt for anyhow::Error {
    fn with_code(self, code: ErrorCode) -> anyhow::Error {
        anyhow::Error::new(CodedError {
            code,
            source: Some(self.into()),
        })
    }
}

/// Like `anyhow::bail!` but also tags the resulting error with an `ErrorCode`.
#[macro_export]
macro_rules! bail_coded {
    ($code:expr, $($arg:tt)*) => {
        return Err($crate::error::coded($code).context(format!($($arg)*)))
    };
}

/// Wrapper around `anyhow::Error` that implements `Serialize` for Tauri IPC.
pub struct CommandError(anyhow::Error);

impl fmt::Debug for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:#}", self.0)
    }
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            code: ErrorCode,
            message: &'a str,
        }
        let code = extract_code(&self.0);
        let message = outermost_message(&self.0);
        Payload {
            code,
            message: &message,
        }
        .serialize(serializer)
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(error: anyhow::Error) -> Self {
        // Full chain goes to BOTH logs and the user-facing toast — the
        // outermost `.context(...)` label is usually too generic to be
        // actionable on its own (e.g. "mergePullRequest failed" hides
        // the actual "Merge commits are not allowed" reason underneath).
        let code = extract_code(&error);
        if code == ErrorCode::ForgeOnboarding {
            tracing::warn!(
                code = ?code,
                error = %format!("{error:#}"),
                error_debug = ?error,
                "Tauri command failed"
            );
        } else {
            tracing::error!(
                code = ?code,
                error = %format!("{error:#}"),
                error_debug = ?error,
                "Tauri command failed"
            );
        }
        CommandError(error)
    }
}

/// First [`CodedError`] found anywhere in the chain.
pub fn extract_code(err: &anyhow::Error) -> ErrorCode {
    err.chain()
        .find_map(|e| e.downcast_ref::<CodedError>())
        .map(CodedError::code)
        .unwrap_or(ErrorCode::Unknown)
}

/// Full error chain rendered as `outer: middle: root`, with `CodedError`
/// marker layers stripped out. This is what the user sees in the toast —
/// the outer `.context(...)` label alone is usually too vague to act on
/// (e.g. "mergePullRequest failed" hides "Merge commits are not allowed
/// on this repository"), so we surface the whole chain.
pub fn outermost_message(err: &anyhow::Error) -> String {
    let parts: Vec<String> = err
        .chain()
        .filter(|e| e.downcast_ref::<CodedError>().is_none())
        .map(|e| e.to_string())
        .collect();
    if parts.is_empty() {
        "Unknown error".into()
    } else {
        parts.join(": ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coded_then_context_joins_full_chain_skipping_marker() {
        let err: anyhow::Error = coded(ErrorCode::WorkspaceBroken)
            .context("outer message")
            .context("outermost");
        assert_eq!(extract_code(&err), ErrorCode::WorkspaceBroken);
        // Marker is stripped; both context layers are joined.
        assert_eq!(outermost_message(&err), "outermost: outer message");
    }

    #[test]
    fn with_code_wraps_existing_chain() {
        let base: anyhow::Error = anyhow::anyhow!("io failed").context("while reading file");
        let tagged = base.with_code(ErrorCode::WorkspaceBroken);
        assert_eq!(extract_code(&tagged), ErrorCode::WorkspaceBroken);
        // The marker now sits at the outermost layer. Strip it and join
        // the rest — the user sees the full causal chain.
        assert_eq!(outermost_message(&tagged), "while reading file: io failed");
    }

    /// Mirrors the real merge-PR failure: the outer `.context(...)` is a
    /// generic label and the actionable detail lives in inner layers.
    /// Toast users need to see the full chain, not just "mergePullRequest
    /// failed".
    #[test]
    fn surfaces_inner_cause_through_generic_outer_context() {
        let inner = anyhow::anyhow!(
            "`gh api graphql` failed: gh: Merge commits are not allowed on this repository."
        );
        let err = inner.context("mergePullRequest failed");
        assert_eq!(
            outermost_message(&err),
            "mergePullRequest failed: `gh api graphql` failed: gh: Merge commits are not allowed on this repository."
        );
    }

    #[test]
    fn bail_coded_macro_tags_error() {
        fn op() -> anyhow::Result<()> {
            bail_coded!(ErrorCode::WorkspaceNotFound, "workspace {} missing", "abc");
        }
        let err = op().unwrap_err();
        assert_eq!(extract_code(&err), ErrorCode::WorkspaceNotFound);
        assert_eq!(outermost_message(&err), "workspace abc missing");
    }

    #[test]
    fn unknown_when_no_marker() {
        let err: anyhow::Error = anyhow::anyhow!("plain error");
        assert_eq!(extract_code(&err), ErrorCode::Unknown);
        assert_eq!(outermost_message(&err), "plain error");
    }

    #[test]
    fn serializes_as_code_and_message() {
        let err: CommandError = coded(ErrorCode::WorkspaceNotFound)
            .context("Workspace not found: abc")
            .into();
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(
            json,
            r#"{"code":"WorkspaceNotFound","message":"Workspace not found: abc"}"#
        );
    }

    #[test]
    fn full_chain_logged_message_stripped_of_marker() {
        let err: anyhow::Error = coded(ErrorCode::WorkspaceBroken).context("dir missing at /foo");
        let full = format!("{err:#}");
        // Full chain format is used for logs; it will include the marker's Display.
        // Frontend sees outermost_message which skips it.
        assert!(full.contains("dir missing at /foo"));
        assert_eq!(outermost_message(&err), "dir missing at /foo");
    }
}
