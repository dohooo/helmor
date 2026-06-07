//! Cross-platform local IPC socket for Helmor's single-instance UI-sync channel.
//!
//! A running Helmor instance binds an `AF_UNIX` stream socket under the app's
//! run directory; a second invocation (e.g. opening a deep link) connects to it
//! to hand off the event instead of starting a duplicate window. `AF_UNIX` is
//! native on Unix and on Windows 10 1803+ (exposed here via `uds_windows`), so
//! the same filesystem-path-addressed socket works on every desktop target.

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as LocalListener, UnixStream as LocalStream};
#[cfg(windows)]
pub use uds_windows::{UnixListener as LocalListener, UnixStream as LocalStream};
