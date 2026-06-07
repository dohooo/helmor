//! Cross-platform OS abstractions.
//!
//! Each submodule exposes one API with `unix`/`windows` implementations behind
//! it so call sites stay platform-agnostic. Submodules are added per phase of
//! the Windows port (see `docs/superpowers/plans/2026-06-07-windows-port.md`).

pub mod fs;
pub mod ipc;
pub mod process;

use std::path::PathBuf;

/// The user's home directory, cross-platform.
///
/// Prefers `HOME` (the Unix convention, also set by git-bash/CI on Windows),
/// then falls back to `USERPROFILE` and finally `HOMEDRIVE`+`HOMEPATH` on
/// Windows, where GUI processes typically lack `HOME`. Returns `None` only when
/// none of those are set.
pub fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(home));
    }
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(profile));
        }
        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            let mut combined = drive;
            combined.push(path);
            return Some(PathBuf::from(combined));
        }
    }
    None
}
