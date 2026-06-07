//! Where and how the managed `helmor` CLI entrypoint is installed.
//!
//! - **Unix:** a symlink at `/usr/local/bin/<name>` pointing at the bundled
//!   `helmor-cli` inside the app bundle (creation lives in
//!   `commands/system_commands.rs`, which owns the elevation flow).
//! - **Windows:** a `<name>.cmd` shim in `%LOCALAPPDATA%\Helmor\bin` that
//!   forwards to the bundled `helmor-cli.exe`, with that bin dir registered
//!   on the **user** `PATH` (`HKCU\Environment`) once. A shim (rather than a
//!   copy) keeps the CLI auto-tracking app upgrades, mirroring what the Unix
//!   symlink achieves.

use std::path::PathBuf;

/// Default install path of the user-facing CLI entrypoint (`helmor`, or
/// `helmor-dev` for debug builds).
pub fn install_target(cli_name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        shim_dir().join(format!("{cli_name}.cmd"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(format!("/usr/local/bin/{cli_name}"))
    }
}

/// `%LOCALAPPDATA%\Helmor\bin` — beside the NSIS per-user install dir, so an
/// uninstall that clears `%LOCALAPPDATA%\Helmor` takes the shim with it.
#[cfg(windows)]
pub fn shim_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| super::home_dir().map(|home| home.join("AppData").join("Local")))
        .unwrap_or_default()
        .join("Helmor")
        .join("bin")
}

/// Write the `.cmd` shim and make sure its directory is on the user `PATH`.
#[cfg(windows)]
pub fn write_shim(
    bundled_cli: &std::path::Path,
    install_path: &std::path::Path,
) -> anyhow::Result<()> {
    use anyhow::Context;

    // `%*` forwards all arguments; quoting handles spaces in the install dir.
    let content = format!("@echo off\r\n\"{}\" %*\r\n", bundled_cli.display());
    std::fs::write(install_path, content)
        .with_context(|| format!("Failed to write CLI shim at {}", install_path.display()))?;

    if let Some(dir) = install_path.parent() {
        ensure_user_path_contains(dir)?;
    }
    Ok(())
}

/// Extract the target executable a `.cmd` shim forwards to, if the file
/// looks like one of ours. Used to classify Managed vs. Stale.
#[cfg(windows)]
pub fn read_shim_target(install_path: &std::path::Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(install_path).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('"') {
            if let Some(end) = rest.find('"') {
                return Some(PathBuf::from(&rest[..end]));
            }
        }
    }
    None
}

/// Append `dir` to the user `PATH` (`HKCU\Environment`) if it isn't already
/// there, preserving `REG_EXPAND_SZ` semantics, then broadcast
/// `WM_SETTINGCHANGE` so newly spawned shells see it. Existing shells keep
/// their environment — that's inherent to Windows, not a bug here.
#[cfg(windows)]
fn ensure_user_path_contains(dir: &std::path::Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};

    let env = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .context("Failed to open HKCU\\Environment")?;
    let current: String = env.get_value("Path").unwrap_or_default();

    let already_present = std::env::split_paths(&std::ffi::OsString::from(&current))
        .any(|entry| entry.as_os_str().eq_ignore_ascii_case(dir.as_os_str()));
    if already_present {
        return Ok(());
    }

    let dir = dir.display();
    let next = if current.is_empty() {
        dir.to_string()
    } else {
        format!("{};{dir}", current.trim_end_matches(';'))
    };
    // Write as REG_EXPAND_SZ: user PATH conventionally holds %VAR% references
    // and a plain REG_SZ write would stop them expanding.
    let mut bytes: Vec<u8> = next
        .encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect();
    env.set_raw_value(
        "Path",
        &RegValue {
            bytes: std::mem::take(&mut bytes),
            vtype: RegType::REG_EXPAND_SZ,
        },
    )
    .context("Failed to update user PATH")?;

    broadcast_environment_change();
    tracing::info!(dir = %dir, "Added CLI shim directory to user PATH");
    Ok(())
}

/// Tell running apps (notably Explorer, which parents new terminals) that the
/// environment changed. Fire-and-forget; a timeout just means some app was
/// hung.
#[cfg(windows)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_target_uses_cli_name() {
        let target = install_target("helmor-dev");
        let name = target.file_name().unwrap().to_string_lossy();
        assert!(
            name == "helmor-dev" || name == "helmor-dev.cmd",
            "unexpected target name: {name}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn shim_round_trips_target_path() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("App Dir").join("helmor-cli.exe");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, "").unwrap();
        let shim = dir.path().join("helmor.cmd");

        // Write the shim body directly (write_shim would also touch the
        // registry, which a unit test must not do).
        let content = format!("@echo off\r\n\"{}\" %*\r\n", bundled.display());
        std::fs::write(&shim, content).unwrap();

        assert_eq!(read_shim_target(&shim).unwrap(), bundled);
    }

    #[cfg(windows)]
    #[test]
    fn read_shim_target_rejects_foreign_files() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("helmor.cmd");
        std::fs::write(&shim, "@echo off\r\nrem not ours\r\n").unwrap();
        assert_eq!(read_shim_target(&shim), None);
    }
}
