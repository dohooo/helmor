//! CLI launcher install seam — *where* and *how* Helmor installs its managed
//! `helmor` CLI launcher for the current OS.
//!
//! The macOS/Unix implementation is the reference behavior: a symlink at
//! `/usr/local/bin/<name>` pointing at the CLI binary inside the app bundle.
//! Windows support fills the stubbed `create_managed_link` (e.g. a `.cmd`/
//! `.exe` shim under `%LOCALAPPDATA%`) and, if shim semantics differ, the
//! `classify` reference — without touching the shared install orchestration
//! in `commands::system_commands`.

use std::io;
use std::path::{Path, PathBuf};

/// State of the managed launcher at the install path, relative to the bundled
/// CLI binary it is expected to resolve to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedCliStatus {
    /// Installed and resolving to the expected bundled binary.
    Managed,
    /// Present, but not a managed link to the expected binary (stale copy or
    /// pointing somewhere else).
    Stale,
    /// Nothing installed at the target path.
    Missing,
}

/// Absolute path where the managed `<cli_name>` launcher is installed.
pub fn install_target(cli_name: &str) -> PathBuf {
    #[cfg(not(windows))]
    {
        PathBuf::from(format!("/usr/local/bin/{cli_name}"))
    }

    #[cfg(windows)]
    {
        // Windows adapter: a user-writable launcher dir (no elevation needed).
        // The actual install mechanism (a `.cmd`/`.exe` shim) is filled in
        // `create_managed_link`; refine this path alongside it.
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(crate::platform::paths::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("Programs")
            .join("Helmor")
            .join("bin")
            .join(format!("{cli_name}.exe"))
    }
}

/// Classify the managed launcher at `install_path` relative to
/// `expected_target` (the bundled CLI binary it should resolve to).
///
/// Reference behavior treats the launcher as a symlink to the bundled binary;
/// a regular file, a wrong target, or a broken link all read as `Stale`.
pub fn classify(install_path: &Path, expected_target: &Path) -> ManagedCliStatus {
    let metadata = match std::fs::symlink_metadata(install_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return ManagedCliStatus::Missing;
        }
        Err(_) => return ManagedCliStatus::Stale,
    };

    if !metadata.file_type().is_symlink() {
        return ManagedCliStatus::Stale;
    }

    let target = match std::fs::read_link(install_path) {
        Ok(target) => target,
        Err(_) => return ManagedCliStatus::Stale,
    };
    let resolved_target = if target.is_absolute() {
        target
    } else {
        install_path
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .join(target)
    };

    match (
        std::fs::canonicalize(resolved_target),
        std::fs::canonicalize(expected_target),
    ) {
        (Ok(installed), Ok(expected)) if installed == expected => ManagedCliStatus::Managed,
        _ => ManagedCliStatus::Stale,
    }
}

/// Create the managed launcher at `dst` resolving to `src`. The caller is
/// responsible for preparing the parent directory and removing any stale
/// entry first.
///
/// Reference (Unix) behavior is a symlink. The Windows adapter replaces this
/// with a shim and must NOT change the Unix arm.
pub fn create_managed_link(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }

    #[cfg(not(unix))]
    {
        let _ = (src, dst);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "managed CLI launcher install is not yet implemented on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_target_uses_unix_bin_path() {
        #[cfg(not(windows))]
        assert_eq!(
            install_target("helmor"),
            PathBuf::from("/usr/local/bin/helmor")
        );
    }

    #[cfg(unix)]
    #[test]
    fn classify_reports_missing_managed_and_stale() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("helmor-cli");
        std::fs::write(&bundled, b"bin").unwrap();
        let install_path = dir.path().join("helmor");

        // Missing: nothing there yet.
        assert_eq!(classify(&install_path, &bundled), ManagedCliStatus::Missing);

        // Managed: a symlink to the expected binary.
        create_managed_link(&bundled, &install_path).unwrap();
        assert_eq!(classify(&install_path, &bundled), ManagedCliStatus::Managed);

        // Stale: a plain file copy instead of a managed link.
        std::fs::remove_file(&install_path).unwrap();
        std::fs::write(&install_path, b"copy").unwrap();
        assert_eq!(classify(&install_path, &bundled), ManagedCliStatus::Stale);
    }
}
