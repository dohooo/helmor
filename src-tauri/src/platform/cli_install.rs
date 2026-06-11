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
        windows_impl::install_target(cli_name)
    }
}

/// Classify the managed launcher at `install_path` relative to
/// `expected_target` (the bundled CLI binary it should resolve to).
///
/// Reference behavior treats the launcher as a symlink to the bundled binary;
/// a regular file, a wrong target, or a broken link all read as `Stale`.
pub fn classify(install_path: &Path, expected_target: &Path) -> ManagedCliStatus {
    #[cfg(windows)]
    {
        windows_impl::classify(install_path, expected_target)
    }
    #[cfg(not(windows))]
    {
        classify_symlink(install_path, expected_target)
    }
}

#[cfg(not(windows))]
fn classify_symlink(install_path: &Path, expected_target: &Path) -> ManagedCliStatus {
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

    #[cfg(windows)]
    {
        windows_impl::create_managed_link(src, dst)
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (src, dst);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "managed CLI launcher install is not yet implemented on this platform",
        ))
    }
}

// Windows can't symlink without elevation, so the managed launcher is a `.cmd`
// shim that forwards to the bundled CLI, plus a one-time registration of the
// shim directory on the user `PATH` (`/usr/local/bin` has no Windows analog).
// `classify` parses the shim's forwarding target instead of `read_link`.
#[cfg(windows)]
mod windows_impl {
    use super::ManagedCliStatus;
    use std::io;
    use std::path::{Path, PathBuf};

    pub(super) fn install_target(cli_name: &str) -> PathBuf {
        shim_dir().join(format!("{cli_name}.cmd"))
    }

    /// `%LOCALAPPDATA%\Helmor\bin` — beside the NSIS per-user install root, so a
    /// user-scope uninstall that clears `%LOCALAPPDATA%\Helmor` removes it too.
    fn shim_dir() -> PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(crate::platform::paths::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Helmor")
            .join("bin")
    }

    pub(super) fn classify(install_path: &Path, expected_target: &Path) -> ManagedCliStatus {
        if std::fs::symlink_metadata(install_path).is_err() {
            return ManagedCliStatus::Missing;
        }
        let Some(target) = read_shim_target(install_path) else {
            return ManagedCliStatus::Stale;
        };
        match (
            std::fs::canonicalize(target),
            std::fs::canonicalize(expected_target),
        ) {
            (Ok(installed), Ok(expected)) if installed == expected => ManagedCliStatus::Managed,
            _ => ManagedCliStatus::Stale,
        }
    }

    pub(super) fn create_managed_link(src: &Path, dst: &Path) -> io::Result<()> {
        // `%*` forwards all args; the quoted target tolerates spaces in the path.
        let content = format!("@echo off\r\n\"{}\" %*\r\n", src.display());
        std::fs::write(dst, content)?;
        if let Some(dir) = dst.parent() {
            ensure_user_path_contains(dir)?;
        }
        Ok(())
    }

    /// Extract the forwarding target from a Helmor `.cmd` shim, if it is one.
    fn read_shim_target(install_path: &Path) -> Option<PathBuf> {
        let content = std::fs::read_to_string(install_path).ok()?;
        for line in content.lines() {
            if let Some(rest) = line.trim().strip_prefix('"') {
                if let Some(end) = rest.find('"') {
                    return Some(PathBuf::from(&rest[..end]));
                }
            }
        }
        None
    }

    /// Append `dir` to the user `PATH` (`HKCU\Environment`) if absent, preserving
    /// `REG_EXPAND_SZ` semantics, then broadcast `WM_SETTINGCHANGE` so new shells
    /// pick it up. Existing shells keep their environment (inherent to Windows).
    fn ensure_user_path_contains(dir: &Path) -> io::Result<()> {
        use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
        use winreg::{RegKey, RegValue};

        let env = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)?;
        let current: String = env.get_value("Path").unwrap_or_default();

        let already = std::env::split_paths(&std::ffi::OsString::from(&current))
            .any(|entry| entry.as_os_str().eq_ignore_ascii_case(dir.as_os_str()));
        if already {
            return Ok(());
        }

        let dir = dir.display();
        let next = if current.is_empty() {
            dir.to_string()
        } else {
            format!("{};{dir}", current.trim_end_matches(';'))
        };
        // REG_EXPAND_SZ: user PATH conventionally holds %VAR% references that a
        // plain REG_SZ write would stop expanding.
        let bytes: Vec<u8> = next
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        env.set_raw_value(
            "Path",
            &RegValue {
                bytes,
                vtype: RegType::REG_EXPAND_SZ,
            },
        )?;
        broadcast_environment_change();
        Ok(())
    }

    fn broadcast_environment_change() {
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        let payload: Vec<u16> = "Environment\0".encode_utf16().collect();
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(payload.as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                2000,
                None,
            );
        }
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

    // Windows launcher is a `.cmd` shim; classify parses its forwarding target.
    // (Built by hand here so the test doesn't touch the user PATH registry the
    // way `create_managed_link` does.)
    #[cfg(windows)]
    #[test]
    fn classify_reads_cmd_shim_target() {
        assert!(install_target("helmor")
            .to_string_lossy()
            .ends_with("helmor.cmd"));

        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("helmor-cli.exe");
        std::fs::write(&bundled, b"bin").unwrap();
        let shim = dir.path().join("helmor.cmd");

        assert_eq!(classify(&shim, &bundled), ManagedCliStatus::Missing);

        std::fs::write(
            &shim,
            format!("@echo off\r\n\"{}\" %*\r\n", bundled.display()),
        )
        .unwrap();
        assert_eq!(classify(&shim, &bundled), ManagedCliStatus::Managed);

        std::fs::write(&shim, b"echo not-a-shim").unwrap();
        assert_eq!(classify(&shim, &bundled), ManagedCliStatus::Stale);
    }
}
