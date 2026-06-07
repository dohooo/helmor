//! Executable lookup helpers for process spawning.

#[cfg(any(windows, test))]
use std::path::Path;
use std::path::PathBuf;

pub fn resolve_for_spawn(program: &str) -> PathBuf {
    resolve_on_path(program).unwrap_or_else(|| PathBuf::from(program))
}

pub fn resolve_on_path(program: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let path = std::env::var_os("PATH")?;
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
        return resolve_on_windows_path(
            program,
            std::env::split_paths(&path).collect::<Vec<_>>(),
            &pathext,
        );
    }

    #[cfg(not(windows))]
    {
        let _ = program;
        None
    }
}

#[cfg(any(windows, test))]
fn resolve_on_windows_path(program: &str, dirs: Vec<PathBuf>, pathext: &str) -> Option<PathBuf> {
    for dir in dirs {
        for candidate in windows_candidates(&dir, program, pathext) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(any(windows, test))]
fn windows_candidates(dir: &Path, program: &str, pathext: &str) -> Vec<PathBuf> {
    let already_has_ext = Path::new(program).extension().is_some();
    let mut candidates = Vec::new();
    if already_has_ext {
        candidates.push(dir.join(program));
        return candidates;
    }
    for ext in pathext.split(';').filter(|ext| !ext.trim().is_empty()) {
        candidates.push(dir.join(format!("{program}{}", ext.to_ascii_lowercase())));
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_spawn_resolution_preserves_bare_program_name() {
        assert_eq!(
            resolve_for_spawn("definitely-not-real"),
            PathBuf::from("definitely-not-real")
        );
    }

    #[test]
    fn windows_candidates_honor_pathext_order() {
        let candidates = windows_candidates(Path::new("C:\\bin"), "npx", ".EXE;.CMD;.BAT");
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("C:\\bin").join("npx.exe"),
                PathBuf::from("C:\\bin").join("npx.cmd"),
                PathBuf::from("C:\\bin").join("npx.bat"),
            ]
        );
    }

    #[test]
    fn windows_candidates_keep_explicit_extension() {
        let candidates = windows_candidates(Path::new("C:\\bin"), "codex.cmd", ".EXE;.CMD");
        assert_eq!(candidates, vec![PathBuf::from("C:\\bin").join("codex.cmd")]);
    }

    #[test]
    fn windows_path_resolution_returns_first_existing_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = dir.path().join("npx.cmd");
        std::fs::write(&cmd, b"").unwrap();

        let resolved = resolve_on_windows_path("npx", vec![dir.path().to_path_buf()], ".EXE;.CMD");

        assert_eq!(resolved, Some(cmd));
    }
}
