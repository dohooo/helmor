//! Reading Claude OAuth credentials from the macOS keychain.
//!
//! Metadata probe (no UI) enumerates accounts; then `/usr/bin/security
//! find-generic-password -w` reads the password for each. Routing the
//! read through the system binary attaches the user's "Always Allow"
//! grant to a signature that never changes, instead of Helmor's
//! (which changes on every upgrade and dev rebuild).

use anyhow::{anyhow, Result};

use super::credentials::{now_ms, parse_credentials, sort_credentials, ClaudeOAuthCredentials};

pub(super) const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[cfg(target_os = "macos")]
const SECURITY_BINARY_PATH: &str = "/usr/bin/security";

/// Per-candidate keychain CLI timeout. On the happy path the read
/// returns in single-digit ms; this only matters when a macOS prompt
/// is up and waiting for the user. 5 min is intentionally generous so
/// users who get up to grab coffee mid-prompt don't come back to a
/// killed dialog.
#[cfg(target_os = "macos")]
const SECURITY_CLI_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// How long we wait between SIGTERM-ing the process group and
/// escalating to SIGKILL. Long enough for `/usr/bin/security` to
/// release its keychain handle and tear down the dialog cleanly.
#[cfg(target_os = "macos")]
const SECURITY_CLI_SIGTERM_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

/// Poll interval while waiting for `/usr/bin/security`. Tighter than
/// `process::run_with_timeout`'s 50ms because we want to react to a
/// timeout fast (the user might be staring at a stuck prompt) and the
/// extra wakeups are negligible for a process that lives ms to s.
#[cfg(target_os = "macos")]
const SECURITY_CLI_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(20);

/// Pick the best credential entry available across all matching
/// keychain items.
pub(super) fn load_best_credentials() -> Result<ClaudeOAuthCredentials> {
    let mut credentials = load_keychain_credentials()?;
    let now = now_ms();
    sort_credentials(&mut credentials, now);
    credentials
        .into_iter()
        .rev()
        .find(|credential| !credential.access_token.trim().is_empty())
        .ok_or_else(|| anyhow!("No Claude Code OAuth credentials found in Keychain"))
}

#[cfg(target_os = "macos")]
fn load_keychain_credentials() -> Result<Vec<ClaudeOAuthCredentials>> {
    let mut credentials = Vec::new();
    for account in keychain_account_candidates().into_iter().take(3) {
        let Some(data) = read_via_security_cli(CLAUDE_KEYCHAIN_SERVICE, Some(&account)) else {
            continue;
        };
        if let Some(credential) = parse_credentials(&data) {
            credentials.push(credential);
        }
    }
    Ok(credentials)
}

#[cfg(not(target_os = "macos"))]
fn load_keychain_credentials() -> Result<Vec<ClaudeOAuthCredentials>> {
    Ok(Vec::new())
}

fn keychain_account_candidates() -> Vec<String> {
    // The metadata probe lists every account name actually present in
    // the keychain for our service — when it succeeds we know exactly
    // which accounts to try and don't need the env-var guesses or the
    // "Claude Code" fallback.
    let probed = keychain_accounts_without_prompt();
    if !probed.is_empty() {
        return probed;
    }

    let mut accounts = Vec::new();
    for key in ["USER", "LOGNAME"] {
        if let Ok(value) = std::env::var(key) {
            push_unique_account(&mut accounts, value);
        }
    }
    push_unique_account(&mut accounts, "Claude Code".to_string());
    accounts
}

#[cfg(target_os = "macos")]
fn keychain_accounts_without_prompt() -> Vec<String> {
    use core_foundation::base::{CFTypeRef, TCFType};
    use core_foundation::string::CFString;
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit, SearchResult};
    use security_framework_sys::item::kSecAttrAccount;

    let results = match ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(CLAUDE_KEYCHAIN_SERVICE)
        .load_attributes(true)
        .skip_authenticated_items(true)
        .limit(Limit::All)
        .search()
    {
        Ok(results) => results,
        Err(error) => {
            tracing::debug!("Claude Keychain account probe failed: {error}");
            return Vec::new();
        }
    };

    // SAFETY: `kSecAttrAccount` is a static `CFStringRef` exported by
    // the Security framework. Casting it to `CFTypeRef` is the standard
    // way to use it as a dictionary key — the underlying object is
    // immortal so no retain/release dance is required.
    let account_key = unsafe { kSecAttrAccount as CFTypeRef };
    results
        .into_iter()
        .filter_map(|result| {
            let SearchResult::Dict(attrs) = result else {
                return None;
            };
            let account = attrs.find(account_key)?;
            // SAFETY: `attrs` returned a `CFTypeRef` we know is a
            // `CFStringRef` (account attribute). `wrap_under_get_rule`
            // takes a borrowed reference and increments the retain
            // count, balanced by `CFString`'s `Drop`.
            let account = unsafe { CFString::wrap_under_get_rule(*account as _) };
            let account = account.to_string();
            (!account.trim().is_empty()).then_some(account)
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn keychain_accounts_without_prompt() -> Vec<String> {
    Vec::new()
}

fn push_unique_account(accounts: &mut Vec<String>, account: String) {
    let trimmed = account.trim();
    if trimmed.is_empty() || accounts.iter().any(|existing| existing == trimmed) {
        return;
    }
    accounts.push(trimmed.to_string());
}

/// `/usr/bin/security find-generic-password -s <service> -a <account> -w`.
///
/// Returns the keychain item's password bytes on success, `None`
/// otherwise (binary missing, non-zero exit, timeout, hung prompt).
/// On timeout the entire process group is SIGTERM'd and then SIGKILL'd
/// to avoid leaking a hung subprocess; macOS dismisses the keychain
/// dialog when the requesting process dies.
#[cfg(target_os = "macos")]
fn read_via_security_cli(service: &str, account: Option<&str>) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    if !std::path::Path::new(SECURITY_BINARY_PATH).exists() {
        tracing::debug!("/usr/bin/security not present, skipping CLI read");
        return None;
    }

    let mut cmd = Command::new(SECURITY_BINARY_PATH);
    cmd.arg("find-generic-password").args(["-s", service]);
    if let Some(a) = account.filter(|a| !a.is_empty()) {
        cmd.args(["-a", a]);
    }
    cmd.arg("-w");
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());

    // SAFETY: `setpgid` is async-signal-safe, which is the only family
    // of calls allowed between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(error) => {
            tracing::debug!("Failed to spawn /usr/bin/security: {error}");
            return None;
        }
    };
    let pgid = child.id() as libc::pid_t;
    let deadline = Instant::now() + SECURITY_CLI_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    // Common cases: item not found, user denied, etc.
                    // Logged at debug since "not found" is normal on
                    // first launch before the user has run claude login.
                    tracing::debug!(
                        "/usr/bin/security exited with status {status:?} for service {service}"
                    );
                    return None;
                }
                let mut buf = Vec::new();
                child.stdout.as_mut()?.read_to_end(&mut buf).ok()?;
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                if buf.is_empty() {
                    return None;
                }
                return Some(buf);
            }
            Ok(None) if Instant::now() >= deadline => {
                tracing::warn!(
                    "/usr/bin/security read timed out after {:?}, killing process group",
                    SECURITY_CLI_TIMEOUT
                );
                // SAFETY: passing a negative pid to `kill` signals the
                // whole process group rooted at `pgid`. `pgid` is the
                // child we just `setpgid(0, 0)`'d, so the only members
                // are `/usr/bin/security` and any subprocess it forked.
                unsafe {
                    libc::kill(-pgid, libc::SIGTERM);
                }
                std::thread::sleep(SECURITY_CLI_SIGTERM_GRACE);
                if matches!(child.try_wait(), Ok(None)) {
                    // SAFETY: same as above. SIGKILL is the escalation
                    // when the SIGTERM grace period didn't reap.
                    unsafe {
                        libc::kill(-pgid, libc::SIGKILL);
                    }
                    let _ = child.kill();
                }
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(SECURITY_CLI_POLL_INTERVAL),
            Err(error) => {
                tracing::debug!("/usr/bin/security try_wait failed: {error}");
                return None;
            }
        }
    }
}
