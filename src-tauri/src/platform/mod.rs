//! Small platform boundary for OS-sensitive behavior.
//!
//! The macOS/Unix implementation is the reference behavior. Future Windows
//! support should add isolated adapter behavior here instead of scattering
//! `cfg(windows)` through feature code.

pub mod cli_install;
pub mod executable;
pub mod fs;
pub mod ipc;
pub mod paths;
pub mod process;
pub mod pty;
pub mod shell;
