//! Cross-platform path resolution helpers.

use std::ffi::OsString;
use std::path::PathBuf;

pub fn home_dir() -> Option<PathBuf> {
    home_dir_from_parts(
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        std::env::var_os("HOMEDRIVE"),
        std::env::var_os("HOMEPATH"),
    )
}

pub fn home_dir_or_root() -> PathBuf {
    home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn home_dir_or_current_or_root() -> PathBuf {
    home_dir()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn codex_home_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir_or_root().join(".codex"))
}

pub fn xdg_config_dir(app_name: &str) -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(xdg).join(app_name));
    }
    Some(home_dir()?.join(".config").join(app_name))
}

fn home_dir_from_parts(
    home: Option<OsString>,
    userprofile: Option<OsString>,
    homedrive: Option<OsString>,
    homepath: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(home) = home.filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }

    #[cfg(windows)]
    {
        windows_home_dir_from_parts(userprofile, homedrive, homepath)
    }

    #[cfg(not(windows))]
    {
        let _ = (userprofile, homedrive, homepath);
        None
    }
}

#[cfg(any(windows, test))]
fn windows_home_dir_from_parts(
    userprofile: Option<OsString>,
    homedrive: Option<OsString>,
    homepath: Option<OsString>,
) -> Option<PathBuf> {
    if let Some(profile) = userprofile.filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(profile));
    }
    let (Some(mut drive), Some(path)) = (homedrive, homepath) else {
        return None;
    };
    if drive.is_empty() || path.is_empty() {
        return None;
    }
    drive.push(path);
    Some(PathBuf::from(drive))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_dir_prefers_home() {
        let home = home_dir_from_parts(
            Some("/Users/me".into()),
            Some("C:\\Users\\me".into()),
            None,
            None,
        );
        assert_eq!(home, Some(PathBuf::from("/Users/me")));
    }

    #[test]
    fn windows_home_dir_falls_back_to_userprofile() {
        let home = windows_home_dir_from_parts(Some("C:\\Users\\me".into()), None, None);
        assert_eq!(home, Some(PathBuf::from("C:\\Users\\me")));
    }

    #[test]
    fn windows_home_dir_combines_drive_and_path() {
        let home = windows_home_dir_from_parts(None, Some("C:".into()), Some("\\Users\\me".into()));
        assert_eq!(home, Some(PathBuf::from("C:\\Users\\me")));
    }
}
