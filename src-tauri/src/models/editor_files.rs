use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use uuid::Uuid;

use super::workspaces;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileReadResponse {
    pub path: String,
    pub content: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileWriteResponse {
    pub path: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileStatResponse {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub mtime_ms: Option<i64>,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileListItem {
    pub path: String,
    pub absolute_path: String,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFilePrefetchItem {
    pub absolute_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFilesWithContentResponse {
    pub items: Vec<EditorFileListItem>,
    pub prefetched: Vec<EditorFilePrefetchItem>,
}

pub fn read_editor_file(path: &str) -> Result<EditorFileReadResponse> {
    let resolved_path = resolve_allowed_path(Path::new(path), true)?;
    let metadata = fs::metadata(&resolved_path)
        .with_context(|| format!("Failed to stat editor file {}", resolved_path.display()))?;

    if !metadata.is_file() {
        bail!("Editor target is not a file: {}", resolved_path.display());
    }

    let bytes = fs::read(&resolved_path)
        .with_context(|| format!("Failed to read editor file {}", resolved_path.display()))?;
    let content = String::from_utf8(bytes).with_context(|| {
        format!(
            "Editor file is not valid UTF-8: {}",
            resolved_path.display()
        )
    })?;

    Ok(EditorFileReadResponse {
        path: resolved_path.display().to_string(),
        content,
        mtime_ms: metadata_mtime_ms(&metadata)?,
    })
}

pub fn write_editor_file(path: &str, content: &str) -> Result<EditorFileWriteResponse> {
    let resolved_path = resolve_allowed_path(Path::new(path), true)?;
    let metadata = fs::metadata(&resolved_path)
        .with_context(|| format!("Failed to stat editor file {}", resolved_path.display()))?;

    if !metadata.is_file() {
        bail!("Editor target is not a file: {}", resolved_path.display());
    }

    atomic_write_file(&resolved_path, content.as_bytes())?;

    let updated_metadata = fs::metadata(&resolved_path).with_context(|| {
        format!(
            "Failed to stat editor file after save {}",
            resolved_path.display()
        )
    })?;

    Ok(EditorFileWriteResponse {
        path: resolved_path.display().to_string(),
        mtime_ms: metadata_mtime_ms(&updated_metadata)?,
    })
}

pub fn stat_editor_file(path: &str) -> Result<EditorFileStatResponse> {
    let resolved_path = resolve_allowed_path(Path::new(path), false)?;

    match fs::metadata(&resolved_path) {
        Ok(metadata) => Ok(EditorFileStatResponse {
            path: resolved_path.display().to_string(),
            exists: true,
            is_file: metadata.is_file(),
            mtime_ms: Some(metadata_mtime_ms(&metadata)?),
            size: Some(metadata.len() as i64),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(EditorFileStatResponse {
            path: resolved_path.display().to_string(),
            exists: false,
            is_file: false,
            mtime_ms: None,
            size: None,
        }),
        Err(error) => Err(error)
            .with_context(|| format!("Failed to stat editor file {}", resolved_path.display())),
    }
}

pub fn list_editor_files(workspace_root_path: &str) -> Result<Vec<EditorFileListItem>> {
    let workspace_root = resolve_allowed_path(Path::new(workspace_root_path), true)?;
    let metadata = fs::metadata(&workspace_root)
        .with_context(|| format!("Failed to stat workspace root {}", workspace_root.display()))?;

    if !metadata.is_dir() {
        bail!(
            "Workspace root is not a directory: {}",
            workspace_root.display()
        );
    }

    let mut discovered_files = Vec::<PathBuf>::new();
    collect_editor_files(&workspace_root, &workspace_root, &mut discovered_files)?;
    discovered_files.sort_by(|left, right| {
        editor_file_sort_key(&workspace_root, left)
            .cmp(&editor_file_sort_key(&workspace_root, right))
    });
    discovered_files.truncate(24);

    Ok(discovered_files
        .into_iter()
        .filter_map(|path| {
            let relative_path = path.strip_prefix(&workspace_root).ok()?;
            Some(EditorFileListItem {
                path: relative_path.to_string_lossy().replace('\\', "/"),
                absolute_path: path.display().to_string(),
                name: path.file_name()?.to_string_lossy().to_string(),
                status: "M".to_string(),
            })
        })
        .collect())
}

/// List workspace files and eagerly read their contents in a single IPC call.
/// Files larger than 1 MB or non-UTF-8 files are skipped in the prefetch list.
pub fn list_editor_files_with_content(
    workspace_root_path: &str,
) -> Result<EditorFilesWithContentResponse> {
    let items = list_editor_files(workspace_root_path)?;

    const MAX_PREFETCH_BYTES: u64 = 1_048_576; // 1 MB

    let prefetched = items
        .iter()
        .filter_map(|item| {
            let path = Path::new(&item.absolute_path);
            let metadata = fs::metadata(path).ok()?;
            if metadata.len() > MAX_PREFETCH_BYTES {
                return None;
            }
            let bytes = fs::read(path).ok()?;
            let content = String::from_utf8(bytes).ok()?;
            Some(EditorFilePrefetchItem {
                absolute_path: item.absolute_path.clone(),
                content,
            })
        })
        .collect();

    Ok(EditorFilesWithContentResponse { items, prefetched })
}

fn resolve_allowed_path(path: &Path, require_existing: bool) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("Editor file paths must be absolute: {}", path.display());
    }

    let normalized_path = if require_existing || path.exists() {
        path.canonicalize()
            .with_context(|| format!("Failed to resolve editor file {}", path.display()))?
    } else {
        canonicalize_missing_path(path)?
    };

    let workspace_roots = allowed_workspace_roots()?;

    if workspace_roots.is_empty() {
        bail!("No workspace roots are available for in-app editing");
    }

    if workspace_roots
        .iter()
        .any(|workspace_root| normalized_path.starts_with(workspace_root))
    {
        return Ok(normalized_path);
    }

    bail!(
        "Editor file must live inside a workspace root: {}",
        path.display()
    )
}

fn allowed_workspace_roots() -> Result<Vec<PathBuf>> {
    let mut workspace_roots = Vec::new();

    for record in workspaces::load_workspace_records()? {
        let workspace_dir =
            crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)
                .with_context(|| {
                    format!(
                        "Failed to resolve workspace directory for {}/{}",
                        record.repo_name, record.directory_name
                    )
                })?;

        if !workspace_dir.is_dir() {
            continue;
        }

        workspace_roots.push(workspace_dir.canonicalize().with_context(|| {
            format!(
                "Failed to resolve workspace root {}",
                workspace_dir.display()
            )
        })?);
    }

    workspace_roots.sort();
    workspace_roots.dedup();

    Ok(workspace_roots)
}

fn collect_editor_files(
    workspace_root: &Path,
    current_dir: &Path,
    discovered_files: &mut Vec<PathBuf>,
) -> Result<()> {
    if discovered_files.len() >= 48 {
        return Ok(());
    }

    let mut entries = fs::read_dir(current_dir)
        .with_context(|| {
            format!(
                "Failed to read workspace directory {}",
                current_dir.display()
            )
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| {
            format!(
                "Failed to iterate workspace directory {}",
                current_dir.display()
            )
        })?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if discovered_files.len() >= 48 {
            break;
        }

        let entry_path = entry.path();
        let file_type = entry.file_type().with_context(|| {
            format!("Failed to inspect workspace entry {}", entry_path.display())
        })?;

        if file_type.is_dir() {
            if should_skip_editor_dir(workspace_root, &entry_path) {
                continue;
            }

            collect_editor_files(workspace_root, &entry_path, discovered_files)?;
            continue;
        }

        if file_type.is_file() && should_include_editor_file(&entry_path) {
            discovered_files.push(entry_path);
        }
    }

    Ok(())
}

fn should_skip_editor_dir(workspace_root: &Path, path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return true;
    };

    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "build"
            | "coverage"
            | "target"
            | ".next"
            | ".turbo"
            | ".cache"
            | ".venv"
            | "__pycache__"
    ) || (name.starts_with('.') && path != workspace_root)
}

fn should_include_editor_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    if matches!(
        file_name,
        "package.json"
            | "pnpm-lock.yaml"
            | "bun.lock"
            | "Cargo.toml"
            | "Cargo.lock"
            | "tsconfig.json"
            | "vite.config.ts"
            | "README.md"
            | "AGENTS.md"
            | "DESIGN.md"
    ) {
        return true;
    }

    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some(
            "ts" | "tsx"
                | "js"
                | "jsx"
                | "rs"
                | "json"
                | "toml"
                | "md"
                | "css"
                | "html"
                | "yml"
                | "yaml"
                | "py"
                | "go"
                | "java"
                | "swift"
                | "kt"
        )
    )
}

fn editor_file_sort_key(workspace_root: &Path, path: &Path) -> (usize, usize, String) {
    let relative = path
        .strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let depth = relative.matches('/').count();
    let priority = if relative.starts_with("src/") {
        0
    } else if relative.starts_with("app/")
        || relative.starts_with("lib/")
        || relative.starts_with("components/")
    {
        1
    } else if depth == 0 {
        2
    } else {
        3
    };

    (priority, depth, relative)
}

fn atomic_write_file(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("Editor file has no parent directory: {}", path.display()))?;
    let file_name = path
        .file_name()
        .with_context(|| format!("Editor file has no file name: {}", path.display()))?
        .to_string_lossy();
    let temp_path = parent.join(format!(".{file_name}.helmor-{}", Uuid::new_v4()));

    let write_result = (|| -> Result<()> {
        let mut temp_file = fs::OpenOptions::new()
            .create_new(true)
            .truncate(true)
            .write(true)
            .open(&temp_path)
            .with_context(|| {
                format!("Failed to create temp editor file {}", temp_path.display())
            })?;

        temp_file
            .write_all(content)
            .with_context(|| format!("Failed to write temp editor file {}", temp_path.display()))?;
        temp_file
            .sync_all()
            .with_context(|| format!("Failed to flush temp editor file {}", temp_path.display()))?;

        if let Ok(metadata) = fs::metadata(path) {
            fs::set_permissions(&temp_path, metadata.permissions()).with_context(|| {
                format!(
                    "Failed to copy permissions onto temp editor file {}",
                    temp_path.display()
                )
            })?;
        }

        fs::rename(&temp_path, path).with_context(|| {
            format!(
                "Failed to replace editor file {} with {}",
                path.display(),
                temp_path.display()
            )
        })?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

fn canonicalize_missing_path(path: &Path) -> Result<PathBuf> {
    let mut missing_segments = Vec::<OsString>::new();
    let mut current = path;

    while !current.exists() {
        let segment = current
            .file_name()
            .with_context(|| format!("Editor path has no file name: {}", path.display()))?;
        missing_segments.push(segment.to_os_string());
        current = current
            .parent()
            .with_context(|| format!("Editor path has no parent: {}", path.display()))?;
    }

    let mut resolved = current
        .canonicalize()
        .with_context(|| format!("Failed to resolve editor parent {}", current.display()))?;

    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }

    Ok(resolved)
}

fn metadata_mtime_ms(metadata: &fs::Metadata) -> Result<i64> {
    let duration = metadata
        .modified()
        .context("Failed to read file modification time")?
        .duration_since(UNIX_EPOCH)
        .context("File modification time predates the Unix epoch")?;

    i64::try_from(duration.as_millis()).context("File modification time exceeds i64 range")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_dir::TEST_ENV_LOCK as TEST_LOCK;
    use rusqlite::Connection;

    struct TestDataDir {
        root: PathBuf,
    }

    impl TestDataDir {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("helmor-test-{name}-{}", Uuid::new_v4()));
            std::env::set_var("HELMOR_DATA_DIR", root.display().to_string());
            crate::data_dir::ensure_directory_structure().unwrap();

            let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
            crate::schema::ensure_schema(&connection).unwrap();

            Self { root }
        }
    }

    impl Drop for TestDataDir {
        fn drop(&mut self) {
            std::env::remove_var("HELMOR_DATA_DIR");
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct EditorFilesHarness {
        _test_dir: TestDataDir,
        workspace_dir: PathBuf,
        outside_dir: PathBuf,
    }

    impl EditorFilesHarness {
        fn new() -> Self {
            let test_dir = TestDataDir::new("editor-files");
            let source_repo_root = test_dir.root.join("source-repo");
            fs::create_dir_all(&source_repo_root).unwrap();

            let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
            connection
                .execute(
                    "INSERT INTO repos (id, name, root_path) VALUES ('repo-1', 'helmor', ?1)",
                    [source_repo_root.display().to_string()],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status) VALUES ('workspace-1', 'repo-1', 'editor-mode', 'ready', 'in-progress')",
                    [],
                )
                .unwrap();

            let workspace_dir = crate::data_dir::workspace_dir("helmor", "editor-mode").unwrap();
            fs::create_dir_all(&workspace_dir).unwrap();

            let outside_dir = test_dir.root.join("outside");
            fs::create_dir_all(&outside_dir).unwrap();

            Self {
                _test_dir: test_dir,
                workspace_dir,
                outside_dir,
            }
        }
    }

    #[test]
    fn read_editor_file_rejects_paths_outside_workspace_roots() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let outside_file = harness.outside_dir.join("not-allowed.ts");
        fs::write(&outside_file, "console.log('x')\n").unwrap();

        let error = read_editor_file(outside_file.to_str().unwrap()).unwrap_err();

        assert!(
            format!("{error:#}").contains("inside a workspace root"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn write_editor_file_replaces_existing_file_contents() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let allowed_file = harness.workspace_dir.join("src").join("App.tsx");
        fs::create_dir_all(allowed_file.parent().unwrap()).unwrap();
        fs::write(&allowed_file, "const before = true;\n").unwrap();

        let response =
            write_editor_file(allowed_file.to_str().unwrap(), "const after = true;\n").unwrap();

        assert_eq!(
            fs::read_to_string(&allowed_file).unwrap(),
            "const after = true;\n"
        );
        assert!(response.mtime_ms > 0);
    }

    #[test]
    fn stat_editor_file_reports_missing_files_inside_workspace_roots() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let missing_file = harness.workspace_dir.join("src").join("missing.ts");

        let response = stat_editor_file(missing_file.to_str().unwrap()).unwrap();

        assert_eq!(
            PathBuf::from(&response.path),
            canonicalize_missing_path(&missing_file).unwrap()
        );
        assert!(!response.exists);
        assert!(!response.is_file);
        assert_eq!(response.mtime_ms, None);
        assert_eq!(response.size, None);
    }

    #[test]
    fn list_editor_files_returns_existing_workspace_files() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let src_dir = harness.workspace_dir.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        let app_file = src_dir.join("App.tsx");
        fs::write(&app_file, "export const app = true;\n").unwrap();
        fs::write(harness.workspace_dir.join("README.md"), "# Demo\n").unwrap();

        let files = list_editor_files(harness.workspace_dir.to_str().unwrap()).unwrap();

        assert!(!files.is_empty());
        let expected_app_file = app_file.canonicalize().unwrap();
        assert!(files
            .iter()
            .any(|file| PathBuf::from(&file.absolute_path) == expected_app_file));
        assert!(files
            .iter()
            .all(|file| Path::new(&file.absolute_path).is_file()));
    }
}
