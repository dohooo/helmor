//! Reading Claude OAuth credentials from the on-disk file Claude CLI
//! uses on Linux.
//!
//! Unlike macOS (Keychain) and Windows (DPAPI), Linux Claude CLI does
//! not call out to libsecret / GNOME Keyring / kwallet. It writes the
//! credentials to `~/.claude/.credentials.json` (or the directory in
//! `$CLAUDE_CONFIG_DIR`) as a plain JSON file. We mirror the same
//! lookup order so Helmor reads from exactly the file Claude CLI
//! itself reads from — no IPC, no daemon, no extra dependencies.

use std::fs;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};

use super::credentials::{now_ms, parse_credentials, sort_credentials, ClaudeOAuthCredentials};

const CREDENTIALS_FILE_NAME: &str = ".credentials.json";
const CLAUDE_DIR_NAME: &str = ".claude";

/// Pick the best credential entry available in the on-disk file.
///
/// Mirrors `keychain::load_best_credentials` — same return type, same
/// "non-empty access_token, best by sort order" selection.
pub(super) fn load_best_credentials() -> Result<ClaudeOAuthCredentials> {
    let mut credentials = load_file_credentials()?;
    let now = now_ms();
    sort_credentials(&mut credentials, now);
    credentials
        .into_iter()
        .rev()
        .find(|credential| !credential.access_token.trim().is_empty())
        .ok_or_else(|| anyhow!("No Claude Code OAuth credentials found in credentials file"))
}

fn load_file_credentials() -> Result<Vec<ClaudeOAuthCredentials>> {
    let path = credentials_path()?;
    if !path.exists() {
        bail!("Claude credentials file not found at {}", path.display());
    }
    let data = fs::read(&path).with_context(|| {
        format!(
            "Failed to read Claude credentials file at {}",
            path.display()
        )
    })?;
    let credential = parse_credentials(&data).ok_or_else(|| {
        anyhow!(
            "Failed to parse Claude credentials file at {} as JSON",
            path.display()
        )
    })?;
    Ok(vec![credential])
}

fn credentials_path() -> Result<PathBuf> {
    let dir = claude_config_dir()?;
    Ok(dir.join(CREDENTIALS_FILE_NAME))
}

fn claude_config_dir() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }
    let home = home_dir()
        .ok_or_else(|| anyhow!("Unable to locate home directory for Claude credentials lookup"))?;
    Ok(home.join(CLAUDE_DIR_NAME))
}

/// Resolve `$HOME` without pulling in the `dirs` crate. On Linux the
/// `HOME` env var is the canonical answer; we never run as a service
/// without it set, and we do not want to add a getpwuid dependency
/// just for this single call site.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    /// Env vars are process-global; the tests in this module mutate
    /// `HOME` and `CLAUDE_CONFIG_DIR`. Serialize them so cargo's
    /// per-binary parallelism doesn't corrupt each other's state.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            // SAFETY: protected by ENV_LOCK; no other thread in this
            // test binary touches env while the guard is alive.
            unsafe { std::env::set_var(key, value) };
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            // SAFETY: see `set`.
            unsafe { std::env::remove_var(key) };
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see `set`.
            unsafe {
                match self.previous.take() {
                    Some(value) => std::env::set_var(self.key, value),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.subsec_nanos())
            .unwrap_or(0);
        path.push(format!("helmor-linux-creds-{label}-{pid}-{nanos}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn returns_error_when_file_is_missing() {
        let _lock = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("missing");
        let _guard = EnvGuard::set("CLAUDE_CONFIG_DIR", &dir);
        let _home_guard = EnvGuard::unset("HOME");

        let error = load_best_credentials().expect_err("missing file should fail");
        let message = error.to_string();
        assert!(
            message.contains("not found"),
            "expected not-found error, got: {message}"
        );

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn returns_error_when_json_is_corrupted() {
        let _lock = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("corrupt");
        let path = dir.join(CREDENTIALS_FILE_NAME);
        fs::write(&path, b"this is not json").expect("write corrupt file");
        let _guard = EnvGuard::set("CLAUDE_CONFIG_DIR", &dir);
        let _home_guard = EnvGuard::unset("HOME");

        let error = load_best_credentials().expect_err("corrupt JSON should fail");
        let message = error.to_string();
        assert!(
            message.contains("parse"),
            "expected parse error, got: {message}"
        );

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn parses_single_valid_credential() {
        let _lock = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("valid");
        let path = dir.join(CREDENTIALS_FILE_NAME);
        let body = br#"{"claudeAiOauth":{"accessToken":"acc-123","refreshToken":"ref-456","expiresAt":9999999999999,"scopes":["user:profile"],"subscriptionType":"pro"}}"#;
        fs::write(&path, body).expect("write valid file");
        let _guard = EnvGuard::set("CLAUDE_CONFIG_DIR", &dir);
        let _home_guard = EnvGuard::unset("HOME");

        let credentials = load_best_credentials().expect("valid credentials should parse");
        assert_eq!(credentials.access_token, "acc-123");
        assert!(credentials.has_required_scope());
        assert!(!credentials.is_expired(0));

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn falls_back_to_home_when_env_var_unset() {
        let _lock = ENV_LOCK.lock().unwrap();
        let home = temp_dir("home-fallback");
        let claude_dir = home.join(CLAUDE_DIR_NAME);
        fs::create_dir_all(&claude_dir).expect("create .claude dir");
        let path = claude_dir.join(CREDENTIALS_FILE_NAME);
        let body =
            br#"{"accessToken":"home-tok","expiresAt":9999999999999,"scopes":["user:profile"]}"#;
        fs::write(&path, body).expect("write valid file");
        let _env_guard = EnvGuard::unset("CLAUDE_CONFIG_DIR");
        let _home_guard = EnvGuard::set("HOME", &home);

        let credentials = load_best_credentials().expect("home fallback should resolve");
        assert_eq!(credentials.access_token, "home-tok");

        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn errors_when_neither_env_nor_home_is_set() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env_guard = EnvGuard::unset("CLAUDE_CONFIG_DIR");
        let _home_guard = EnvGuard::unset("HOME");

        let error = load_best_credentials().expect_err("no env should fail");
        assert!(error.to_string().contains("home directory"));
    }
}
