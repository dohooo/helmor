pub(crate) mod archive;
pub(crate) mod branching;
pub mod files;
pub mod helpers;
pub(crate) mod lifecycle;
pub mod workspaces;

// The Unix script runner uses openpty/setsid/TIOCSCTTY/killpg which have no
// direct Windows equivalent. On Windows we expose a stub with identical
// public API surface so the rest of the crate compiles; Phase 6 replaces the
// stub with a real `cmd.exe /C` + piped-stdio implementation backed by a
// Windows Job Object.
#[cfg(unix)]
pub mod scripts;

#[cfg(not(unix))]
#[path = "scripts_windows_stub.rs"]
pub mod scripts;
