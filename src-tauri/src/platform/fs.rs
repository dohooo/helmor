//! Cross-platform filesystem helpers for the symlink / permission operations
//! that differ between Unix and Windows.

use std::io;
use std::path::Path;

/// Create a symbolic link at `link` that points to `original`.
///
/// `original` may be relative (interpreted relative to `link`'s directory, as
/// usual for symlinks). On Unix this is a plain `symlink(2)`. On Windows the
/// kind of link (file vs directory) must be chosen up front, and creating a
/// symlink may require privilege (Developer Mode or admin); when it can't, we
/// fall back to copying so the workspace operation still succeeds.
pub fn symlink_to(original: &Path, link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(original, link)
    }
    #[cfg(windows)]
    {
        // Resolve `original` relative to the link's parent to learn whether the
        // target is a directory (Windows needs symlink_dir vs symlink_file).
        let resolved = match link.parent() {
            Some(parent) => parent.join(original),
            None => original.to_path_buf(),
        };
        let target_is_dir = std::fs::metadata(&resolved)
            .map(|m| m.is_dir())
            .unwrap_or(false);

        let result = if target_is_dir {
            std::os::windows::fs::symlink_dir(original, link)
        } else {
            std::os::windows::fs::symlink_file(original, link)
        };

        match result {
            Ok(()) => Ok(()),
            // Privilege/permission denied (no Developer Mode): degrade to a copy
            // of the resolved target so the higher-level operation still works.
            Err(_) => {
                if target_is_dir {
                    copy_dir_recursive(&resolved, link)
                } else {
                    std::fs::copy(&resolved, link).map(|_| ())
                }
            }
        }
    }
}

/// Create `dst` as a link to `src`, falling back to a file copy when symlink
/// creation isn't permitted (Windows without symlink privilege).
pub fn link_or_copy(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }
    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_file(src, dst) {
            Ok(()) => Ok(()),
            Err(_) => std::fs::copy(src, dst).map(|_| ()),
        }
    }
}

/// Apply Unix permission bits to `path`. No-op on Windows, which has no
/// equivalent mode concept for the cases Helmor uses (executable bit, etc.).
#[allow(unused_variables)]
pub fn set_unix_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        Ok(())
    }
}

#[cfg(windows)]
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_or_copy_makes_target_readable() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.txt");
        std::fs::write(&src, b"hello").unwrap();
        let dst = dir.path().join("dst.txt");
        link_or_copy(&src, &dst).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"hello");
    }

    #[test]
    fn symlink_to_resolves_relative_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.txt");
        std::fs::write(&target, b"data").unwrap();
        let link = dir.path().join("link.txt");
        // Relative original, as symlinks are typically stored.
        symlink_to(Path::new("target.txt"), &link).unwrap();
        assert_eq!(std::fs::read(&link).unwrap(), b"data");
    }
}
