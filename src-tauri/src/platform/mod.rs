//! Cross-platform OS abstractions.
//!
//! Each submodule exposes one API with `unix`/`windows` implementations behind
//! it so call sites stay platform-agnostic. Submodules are added per phase of
//! the Windows port (see `docs/superpowers/plans/2026-06-07-windows-port.md`).

pub mod cli_install;
pub mod fs;
pub mod ipc;
pub mod process;

use std::path::PathBuf;

/// Resolve a bare program name to a concrete executable on `PATH`.
///
/// On Windows, `CreateProcess` (what `std::process::Command` uses) does NOT
/// consult `PATHEXT`, so a bare name like `bun`/`codex` won't find the `.cmd`,
/// `.exe`, or `.ps1` shims that npm/installers drop on `PATH`. This searches
/// `PATH` honoring `PATHEXT` and returns the first real file. On Unix it returns
/// `None` (the OS resolves bare names via `execvp` already).
#[cfg(windows)]
pub fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
    // If the name already has an extension, accept the exact file; otherwise only
    // a PATHEXT match (an extensionless file on Windows isn't executable).
    let already_has_ext = std::path::Path::new(program).extension().is_some();
    for dir in std::env::split_paths(&path) {
        if already_has_ext {
            let direct = dir.join(program);
            if direct.is_file() {
                return Some(direct);
            }
        }
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{program}{}", ext.to_ascii_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(not(windows))]
pub fn which(_program: &str) -> Option<PathBuf> {
    None
}

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
