use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{bail, Context, Result};
use uuid::Uuid;

use crate::models::workspaces as workspace_models;

pub(super) fn resolve_allowed_path(path: &Path, require_existing: bool) -> Result<PathBuf> {
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

    if workspace_roots
        .iter()
        .any(|workspace_root| normalized_path.starts_with(workspace_root))
    {
        return Ok(normalized_path);
    }

    if path_is_inside_known_workspace(path)? {
        return Ok(normalized_path);
    }

    bail!(
        "Editor file must live inside a workspace root: {}",
        path.display()
    )
}

pub(super) fn path_is_inside_known_workspace(path: &Path) -> Result<bool> {
    if !path.is_absolute() {
        return Ok(false);
    }
    let normalized_path = canonicalize_missing_path(path)?;

    for record in workspace_models::load_workspace_records()? {
        let Ok(workspace_dir) = crate::workspace::helpers::workspace_path(&record) else {
            continue;
        };
        let Ok(normalized_root) = canonicalize_missing_path(&workspace_dir) else {
            continue;
        };
        if normalized_path.starts_with(normalized_root) {
            return Ok(true);
        }
    }

    Ok(false)
}

pub(super) fn allowed_workspace_roots() -> Result<Vec<PathBuf>> {
    let mut workspace_roots = Vec::new();

    for record in workspace_models::load_workspace_records()? {
        let Ok(workspace_dir) = crate::workspace::helpers::workspace_path(&record) else {
            // Malformed repo/directory name — skip rather than nuke the whole
            // picker. Not user-actionable.
            continue;
        };

        if !workspace_dir.is_dir() {
            continue;
        }

        // canonicalize can fail if a parent component vanishes mid-iteration
        // (symlink chain broken, etc.). One broken workspace must not take
        // the whole picker down — skip and keep going.
        match workspace_dir.canonicalize() {
            Ok(path) => workspace_roots.push(path),
            Err(error) => {
                tracing::warn!(
                    path = %workspace_dir.display(),
                    error = %error,
                    "skipping unresolvable workspace root",
                );
            }
        }
    }

    workspace_roots.sort();
    workspace_roots.dedup();

    Ok(workspace_roots)
}

const MAX_WORKSPACE_FILES_FOR_MENTION: usize = 5000;

pub(super) fn collect_workspace_files_for_mention(
    current_dir: &Path,
    discovered_files: &mut Vec<PathBuf>,
) -> Result<()> {
    if discovered_files.len() >= MAX_WORKSPACE_FILES_FOR_MENTION {
        return Ok(());
    }

    let read_dir = match fs::read_dir(current_dir) {
        Ok(iter) => iter,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Subdir vanished between walk start and descent (git checkout,
            // rm -rf, etc.). Skip silently rather than aborting the whole
            // walk — one missing dir shouldn't break the @-mention picker.
            tracing::warn!(
                path = %current_dir.display(),
                "skipping missing workspace subdir during mention walk",
            );
            return Ok(());
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Failed to read workspace directory {}",
                    current_dir.display()
                )
            })
        }
    };
    let mut entries = read_dir
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| {
            format!(
                "Failed to iterate workspace directory {}",
                current_dir.display()
            )
        })?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if discovered_files.len() >= MAX_WORKSPACE_FILES_FOR_MENTION {
            break;
        }

        let entry_path = entry.path();
        let file_type = entry.file_type().with_context(|| {
            format!("Failed to inspect workspace entry {}", entry_path.display())
        })?;

        if file_type.is_dir() {
            if should_skip_workspace_dir_for_mention(&entry_path) {
                continue;
            }

            collect_workspace_files_for_mention(&entry_path, discovered_files)?;
            continue;
        }

        if file_type.is_file() && should_include_workspace_file_for_mention(&entry_path) {
            discovered_files.push(entry_path);
        }
    }

    Ok(())
}

fn should_skip_workspace_dir_for_mention(path: &Path) -> bool {
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
    )
}

fn should_include_workspace_file_for_mention(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    if matches!(file_name, ".DS_Store" | "Thumbs.db" | "desktop.ini") {
        return false;
    }

    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return true;
    };

    let lower = extension.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "tiff"
            | "tif"
            | "avif"
            | "heic"
            | "heif"
            | "mp3"
            | "wav"
            | "flac"
            | "ogg"
            | "m4a"
            | "aac"
            | "wma"
            | "opus"
            | "mp4"
            | "mov"
            | "avi"
            | "mkv"
            | "webm"
            | "m4v"
            | "wmv"
            | "flv"
            | "zip"
            | "tar"
            | "gz"
            | "bz2"
            | "xz"
            | "7z"
            | "rar"
            | "tgz"
            | "tbz2"
            | "zst"
            | "lz"
            | "lzma"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
            | "o"
            | "a"
            | "class"
            | "jar"
            | "war"
            | "ear"
            | "pyc"
            | "pyo"
            | "wasm"
            | "node"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
            | "eot"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "db"
            | "sqlite"
            | "sqlite3"
            | "mdb"
            | "iso"
            | "dmg"
            | "pkg"
            | "deb"
            | "rpm"
            | "msi"
            | "apk"
            | "ipa"
            | "bin"
            | "dat"
    )
}

pub(super) fn collect_editor_files(
    workspace_root: &Path,
    current_dir: &Path,
    discovered_files: &mut Vec<PathBuf>,
) -> Result<()> {
    if discovered_files.len() >= 48 {
        return Ok(());
    }

    let read_dir = match fs::read_dir(current_dir) {
        Ok(iter) => iter,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tracing::warn!(
                path = %current_dir.display(),
                "skipping missing workspace subdir during editor walk",
            );
            return Ok(());
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Failed to read workspace directory {}",
                    current_dir.display()
                )
            })
        }
    };
    let mut entries = read_dir
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

pub(super) fn editor_file_sort_key(workspace_root: &Path, path: &Path) -> (usize, usize, String) {
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

pub(super) fn atomic_write_file(path: &Path, content: &[u8]) -> Result<()> {
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

pub(super) fn canonicalize_missing_path(path: &Path) -> Result<PathBuf> {
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

pub(super) fn metadata_mtime_ms(metadata: &fs::Metadata) -> Result<i64> {
    let duration = metadata
        .modified()
        .context("Failed to read file modification time")?
        .duration_since(UNIX_EPOCH)
        .context("File modification time predates the Unix epoch")?;

    i64::try_from(duration.as_millis()).context("File modification time exceeds i64 range")
}
