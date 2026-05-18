//! Paths to bundled `gh` / `glab` inside `Resources/vendor/`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const GH_PATH_ENV: &str = "HELMOR_GH_BIN_PATH";
pub const GLAB_PATH_ENV: &str = "HELMOR_GLAB_BIN_PATH";

#[derive(Debug, Default, Clone)]
pub struct BundledForgeCliPaths {
    pub gh: Option<PathBuf>,
    pub glab: Option<PathBuf>,
}

static BUNDLED_PATHS: OnceLock<BundledForgeCliPaths> = OnceLock::new();

/// Call once from the Tauri setup hook; later calls are a no-op in release
/// and a debug assertion failure in dev (catches accidental re-init).
pub fn init() {
    let result = BUNDLED_PATHS.set(resolve_from_running_exe());
    debug_assert!(result.is_ok(), "forge::bundled::init called more than once");
    let paths = BUNDLED_PATHS.get();
    tracing::info!(
        gh = ?paths.and_then(|p| p.gh.as_deref()),
        glab = ?paths.and_then(|p| p.glab.as_deref()),
        "Resolved bundled forge CLI paths"
    );
}

/// Env var override > startup-resolved path > `None` (caller falls back to PATH).
pub fn bundled_path_for(program: &str) -> Option<PathBuf> {
    if let Some(env_key) = env_key_for(program) {
        if let Ok(raw) = std::env::var(env_key) {
            let path = PathBuf::from(raw);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let cached = BUNDLED_PATHS.get()?;
    match program {
        "gh" => cached.gh.clone(),
        "glab" => cached.glab.clone(),
        _ => None,
    }
}

fn env_key_for(program: &str) -> Option<&'static str> {
    match program {
        "gh" => Some(GH_PATH_ENV),
        "glab" => Some(GLAB_PATH_ENV),
        _ => None,
    }
}

fn resolve_from_running_exe() -> BundledForgeCliPaths {
    let paths = std::env::current_exe()
        .ok()
        .and_then(|exe| resolve_for_exe(&exe))
        .unwrap_or_default();

    #[cfg(debug_assertions)]
    {
        paths.with_fallback(resolve_for_dev_workspace(&dev_workspace_root()))
    }

    #[cfg(not(debug_assertions))]
    {
        paths
    }
}

fn resolve_for_exe(exe: &Path) -> Option<BundledForgeCliPaths> {
    let exe_dir = exe.parent()?;
    let contents_dir = exe_dir.parent()?;
    let resources_dir = contents_dir.join("Resources");

    let gh_name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let glab_name = if cfg!(windows) { "glab.exe" } else { "glab" };

    let gh = resources_dir.join(format!("vendor/gh/{gh_name}"));
    let glab = resources_dir.join(format!("vendor/glab/{glab_name}"));

    Some(BundledForgeCliPaths {
        gh: gh.is_file().then_some(gh),
        glab: glab.is_file().then_some(glab),
    })
}

#[cfg(debug_assertions)]
impl BundledForgeCliPaths {
    fn with_fallback(self, fallback: BundledForgeCliPaths) -> BundledForgeCliPaths {
        BundledForgeCliPaths {
            gh: self.gh.or(fallback.gh),
            glab: self.glab.or(fallback.glab),
        }
    }
}

#[cfg(debug_assertions)]
fn dev_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

#[cfg(debug_assertions)]
fn resolve_for_dev_workspace(workspace_root: &Path) -> BundledForgeCliPaths {
    let vendor = workspace_root.join("sidecar/dist/vendor");
    let gh_name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let glab_name = if cfg!(windows) { "glab.exe" } else { "glab" };

    let gh = vendor.join(format!("gh/{gh_name}"));
    let glab = vendor.join(format!("glab/{glab_name}"));

    BundledForgeCliPaths {
        gh: gh.is_file().then_some(gh),
        glab: glab.is_file().then_some(glab),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_finds_binaries_under_resources_vendor() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor.app/Contents/MacOS/Helmor");
        let vendor = root.path().join("Helmor.app/Contents/Resources/vendor");
        std::fs::create_dir_all(vendor.join("gh")).unwrap();
        std::fs::create_dir_all(vendor.join("glab")).unwrap();
        std::fs::write(vendor.join("gh/gh"), "").unwrap();
        std::fs::write(vendor.join("glab/glab"), "").unwrap();

        let paths = resolve_for_exe(&exe).unwrap();

        assert_eq!(
            paths.gh.unwrap(),
            root.path()
                .join("Helmor.app/Contents/Resources/vendor/gh/gh")
        );
        assert_eq!(
            paths.glab.unwrap(),
            root.path()
                .join("Helmor.app/Contents/Resources/vendor/glab/glab")
        );
    }

    #[test]
    fn resolve_returns_none_when_binaries_missing() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor.app/Contents/MacOS/Helmor");
        let paths = resolve_for_exe(&exe).unwrap();
        assert!(paths.gh.is_none());
        assert!(paths.glab.is_none());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_finds_debug_vendor_under_workspace_root() {
        let root = tempfile::tempdir().unwrap();
        let vendor = root.path().join("sidecar/dist/vendor");
        std::fs::create_dir_all(vendor.join("gh")).unwrap();
        std::fs::create_dir_all(vendor.join("glab")).unwrap();
        std::fs::write(vendor.join("gh/gh"), "").unwrap();
        std::fs::write(vendor.join("glab/glab"), "").unwrap();

        let paths = resolve_for_dev_workspace(root.path());

        assert_eq!(paths.gh.unwrap(), vendor.join("gh/gh"));
        assert_eq!(paths.glab.unwrap(), vendor.join("glab/glab"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn app_bundle_paths_win_over_debug_vendor() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Helmor.app/Contents/MacOS/Helmor");
        let app_vendor = root.path().join("Helmor.app/Contents/Resources/vendor");
        let dev_vendor = root.path().join("sidecar/dist/vendor");
        std::fs::create_dir_all(app_vendor.join("gh")).unwrap();
        std::fs::create_dir_all(app_vendor.join("glab")).unwrap();
        std::fs::create_dir_all(dev_vendor.join("gh")).unwrap();
        std::fs::create_dir_all(dev_vendor.join("glab")).unwrap();
        std::fs::write(app_vendor.join("gh/gh"), "").unwrap();
        std::fs::write(app_vendor.join("glab/glab"), "").unwrap();
        std::fs::write(dev_vendor.join("gh/gh"), "").unwrap();
        std::fs::write(dev_vendor.join("glab/glab"), "").unwrap();

        let paths = resolve_for_exe(&exe)
            .unwrap()
            .with_fallback(resolve_for_dev_workspace(root.path()));

        assert_eq!(paths.gh.unwrap(), app_vendor.join("gh/gh"));
        assert_eq!(paths.glab.unwrap(), app_vendor.join("glab/glab"));
    }
}
