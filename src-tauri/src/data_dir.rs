//! Resolves the Helmor data directory based on build profile and environment.
//!
//! - Debug builds: `~/helmor-dev/`
//! - Release builds: `~/helmor/`
//! - `HELMOR_DATA_DIR` env var overrides both
//!
//! The SQLite database lives at `{data_dir}/helmor.db`.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};

#[cfg(test)]
pub static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Name of the database file inside the data directory.
const DB_FILENAME: &str = "helmor.db";

/// Default top-level directory name for Helmor app data.
const fn default_data_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "helmor-dev"
    } else {
        "helmor"
    }
}

/// Returns the resolved data directory, creating it if necessary.
pub fn data_dir() -> Result<PathBuf> {
    let dir = resolve_data_dir()?;

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create Helmor data directory {}", dir.display()))?;
    }

    Ok(dir)
}

/// Returns the path to the SQLite database file.
pub fn db_path() -> Result<PathBuf> {
    Ok(data_dir()?.join(DB_FILENAME))
}

/// Returns the workspaces directory inside the data dir.
pub fn workspaces_dir() -> Result<PathBuf> {
    let dir = data_dir()?.join("workspaces");
    if !dir.exists() {
        fs::create_dir_all(&dir).context("Failed to create workspaces directory")?;
    }
    Ok(dir)
}

/// Returns the logs directory inside the data dir.
pub fn logs_dir() -> Result<PathBuf> {
    let dir = data_dir()?.join("logs");
    if !dir.exists() {
        fs::create_dir_all(&dir).context("Failed to create logs directory")?;
    }
    Ok(dir)
}

/// Returns the runtime state directory inside the data dir.
pub fn run_dir() -> Result<PathBuf> {
    let dir = data_dir()?.join("run");
    if !dir.exists() {
        fs::create_dir_all(&dir).context("Failed to create run directory")?;
    }
    Ok(dir)
}

/// Returns the generated images directory inside the data dir.
pub fn generated_images_dir() -> Result<PathBuf> {
    let dir = data_dir()?.join("generated-images");
    if !dir.exists() {
        fs::create_dir_all(&dir).context("Failed to create generated images directory")?;
    }
    Ok(dir)
}

/// Returns the avatar cache directory inside the data dir. Forge account
/// avatars (gh / glab) are downloaded once and served via `asset://` so
/// page navigations don't re-trigger HTTP fetch + image decode.
pub fn avatar_cache_dir() -> Result<PathBuf> {
    let dir = data_dir()?.join("cache").join("avatars");
    if !dir.exists() {
        fs::create_dir_all(&dir).context("Failed to create avatar cache directory")?;
    }
    Ok(dir)
}

/// Returns the Conductor source database path for import.
/// This is the real Conductor database on the local machine.
pub fn conductor_source_db_path() -> Option<PathBuf> {
    let home = dirs_home()?;
    let path = home.join("Library/Application Support/com.conductor.app/conductor.db");
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Returns the Conductor filesystem root directory.
///
/// Reads `conductor_root_path` from the Conductor settings table.
/// Falls back to `~/conductor/` if the setting is absent.
pub fn conductor_root_path() -> Option<PathBuf> {
    let db_path = conductor_source_db_path()?;
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;

    let root: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'conductor_root_path'",
            [],
            |row| row.get(0),
        )
        .ok();

    let path = match root {
        Some(ref s) if !s.is_empty() => PathBuf::from(s),
        _ => dirs_home()?.join("conductor"),
    };

    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// Check if this is a development build.
pub fn is_dev() -> bool {
    cfg!(debug_assertions)
}

/// Resolve the data directory path without creating it.
fn resolve_data_dir() -> Result<PathBuf> {
    // 1. Environment variable override
    if let Ok(dir) = std::env::var("HELMOR_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }

    // 2. Build profile based
    let home = dirs_home().context("Could not determine home directory")?;

    Ok(home.join(default_data_dir_name()))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Ensure all required subdirectories exist.
pub fn ensure_directory_structure() -> Result<()> {
    data_dir()?;
    workspaces_dir()?;
    logs_dir()?;
    run_dir()?;
    generated_images_dir()?;
    Ok(())
}

/// Returns the workspace directory for a given repo + workspace.
pub fn workspace_dir(repo_name: &str, directory_name: &str) -> Result<PathBuf> {
    Ok(workspaces_dir()?.join(repo_name).join(directory_name))
}

/// Returns a human-readable description of the data mode.
pub fn data_mode_label() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    }
}

/// Returns the path to the data directory as resolved (for display/info).
pub fn data_dir_display() -> Result<String> {
    Ok(data_dir()?.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test path construction without touching environment variables.
    /// This avoids races with other test modules that also set HELMOR_DATA_DIR.

    #[test]
    fn db_filename_is_helmor_db() {
        assert_eq!(DB_FILENAME, "helmor.db");
    }

    #[test]
    fn is_dev_returns_true_in_debug() {
        // In test (debug) builds, this should be true
        assert!(is_dev());
    }

    #[test]
    fn data_mode_label_returns_development_in_debug() {
        assert_eq!(data_mode_label(), "development");
    }

    #[test]
    fn default_data_dir_name_returns_dev_directory_in_debug() {
        assert_eq!(default_data_dir_name(), "helmor-dev");
    }

    #[test]
    fn conductor_source_db_path_returns_option() {
        // Just verify it doesn't panic — the result depends on whether
        // Conductor is installed on the build machine.
        let _ = conductor_source_db_path();
    }

    #[test]
    fn dirs_home_returns_some() {
        // HOME should be set in any normal test environment
        assert!(dirs_home().is_some());
    }
}
