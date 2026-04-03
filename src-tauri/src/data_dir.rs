//! Resolves the Helmor data directory based on build profile and environment.
//!
//! - Debug builds: `~/.helmor.dev/`
//! - Release builds: `~/.helmor/`
//! - `HELMOR_DATA_DIR` env var overrides both
//!
//! The SQLite database lives at `{data_dir}/helmor.db`.

use std::fs;
use std::path::PathBuf;

/// Name of the database file inside the data directory.
const DB_FILENAME: &str = "helmor.db";

/// Returns the resolved data directory, creating it if necessary.
pub fn data_dir() -> Result<PathBuf, String> {
    let dir = resolve_data_dir()?;

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| {
            format!(
                "Failed to create Helmor data directory {}: {error}",
                dir.display()
            )
        })?;
    }

    Ok(dir)
}

/// Returns the path to the SQLite database file.
pub fn db_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(DB_FILENAME))
}

/// Returns the workspaces directory inside the data dir.
pub fn workspaces_dir() -> Result<PathBuf, String> {
    let dir = data_dir()?.join("workspaces");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| {
            format!("Failed to create workspaces directory: {error}")
        })?;
    }
    Ok(dir)
}

/// Returns the archived-contexts directory inside the data dir.
pub fn archived_contexts_dir() -> Result<PathBuf, String> {
    let dir = data_dir()?.join("archived-contexts");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| {
            format!("Failed to create archived-contexts directory: {error}")
        })?;
    }
    Ok(dir)
}

/// Returns the repos mirror directory inside the data dir.
pub fn repos_dir() -> Result<PathBuf, String> {
    let dir = data_dir()?.join("repos");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| {
            format!("Failed to create repos directory: {error}")
        })?;
    }
    Ok(dir)
}

/// Returns the logs directory inside the data dir.
pub fn logs_dir() -> Result<PathBuf, String> {
    let dir = data_dir()?.join("logs");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| {
            format!("Failed to create logs directory: {error}")
        })?;
    }
    Ok(dir)
}

/// Returns the Conductor source database path for import.
/// This is the real Conductor database on the local machine.
pub fn conductor_source_db_path() -> Option<PathBuf> {
    let home = dirs_home()?;
    let path = home
        .join("Library/Application Support/com.conductor.app/conductor.db");
    if path.is_file() {
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
fn resolve_data_dir() -> Result<PathBuf, String> {
    // 1. Environment variable override
    if let Ok(dir) = std::env::var("HELMOR_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }

    // 2. Build profile based
    let home = dirs_home().ok_or("Could not determine home directory")?;

    if cfg!(debug_assertions) {
        Ok(home.join(".helmor.dev"))
    } else {
        Ok(home.join(".helmor"))
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Ensure all required subdirectories exist.
pub fn ensure_directory_structure() -> Result<(), String> {
    data_dir()?;
    workspaces_dir()?;
    archived_contexts_dir()?;
    repos_dir()?;
    logs_dir()?;
    Ok(())
}

/// Returns the workspace directory for a given repo + workspace.
pub fn workspace_dir(repo_name: &str, directory_name: &str) -> Result<PathBuf, String> {
    Ok(workspaces_dir()?.join(repo_name).join(directory_name))
}

/// Returns the archived context directory for a given repo + workspace.
pub fn archived_context_dir(repo_name: &str, directory_name: &str) -> Result<PathBuf, String> {
    Ok(archived_contexts_dir()?.join(repo_name).join(directory_name))
}

/// Returns the repo mirror directory.
pub fn repo_mirror_dir(repo_name: &str) -> Result<PathBuf, String> {
    Ok(repos_dir()?.join(repo_name))
}

/// Returns the workspace logs directory.
pub fn workspace_logs_dir(workspace_id: &str) -> Result<PathBuf, String> {
    Ok(logs_dir()?.join("workspaces").join(workspace_id))
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
pub fn data_dir_display() -> Result<String, String> {
    Ok(data_dir()?.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_data_dir_returns_path() {
        // With override
        std::env::set_var("HELMOR_DATA_DIR", "/tmp/helmor-test-data-dir");
        let dir = resolve_data_dir().unwrap();
        assert_eq!(dir, PathBuf::from("/tmp/helmor-test-data-dir"));
        std::env::remove_var("HELMOR_DATA_DIR");
    }

    #[test]
    fn db_path_ends_with_helmor_db() {
        std::env::set_var("HELMOR_DATA_DIR", "/tmp/helmor-test-db-path");
        let path = db_path().unwrap();
        assert!(path.ends_with("helmor.db"));
        std::env::remove_var("HELMOR_DATA_DIR");
        let _ = std::fs::remove_dir_all("/tmp/helmor-test-db-path");
    }

    #[test]
    fn is_dev_returns_true_in_debug() {
        // In test (debug) builds, this should be true
        assert!(is_dev());
    }
}
