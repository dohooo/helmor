//! Filesystem operations whose semantics differ by platform.

use std::io;
use std::path::Path;

pub fn symlink_to(original: &Path, link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(original, link)
    }

    #[cfg(windows)]
    {
        let resolved = match link.parent() {
            Some(parent) => parent.join(original),
            None => original.to_path_buf(),
        };
        let target_is_dir = std::fs::metadata(&resolved)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        let result = if target_is_dir {
            std::os::windows::fs::symlink_dir(original, link)
        } else {
            std::os::windows::fs::symlink_file(original, link)
        };
        match result {
            Ok(()) => Ok(()),
            Err(_) if target_is_dir => copy_dir_recursive(&resolved, link),
            Err(_) => std::fs::copy(&resolved, link).map(|_| ()),
        }
    }
}

pub fn copy_symlink(source: &Path, destination: &Path) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let link_target = std::fs::read_link(source)?;
    symlink_to(&link_target, destination)
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
    fn symlink_to_makes_target_readable() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.txt");
        std::fs::write(&src, b"hello").unwrap();
        let dst = dir.path().join("dst.txt");

        symlink_to(&src, &dst).unwrap();

        assert_eq!(std::fs::read(&dst).unwrap(), b"hello");
    }

    // Unix symlink semantics: the copied link must still be a symlink whose
    // `read_link` returns the exact relative target. On Windows `symlink_to`
    // intentionally falls back to copying when symlink privilege is absent, so
    // this exact-target invariant doesn't hold there.
    #[cfg(unix)]
    #[test]
    fn copy_symlink_preserves_relative_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.txt");
        std::fs::write(&target, b"data").unwrap();
        let src_link = dir.path().join("src-link.txt");
        let dst_link = dir.path().join("nested/dst-link.txt");
        symlink_to(Path::new("../target.txt"), &src_link).unwrap();

        copy_symlink(&src_link, &dst_link).unwrap();

        assert_eq!(
            std::fs::read_link(&dst_link).unwrap(),
            Path::new("../target.txt")
        );
    }
}
