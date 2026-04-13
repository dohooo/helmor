//! Capture the user's login-shell environment so that GUI-launched `.app`
//! bundles inherit the same `PATH` (and friends) that a terminal session
//! would have.
//!
//! On macOS, apps started from Finder / Spotlight only see the bare system
//! `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`). Homebrew, nvm, pnpm, cargo,
//! and basically every developer tool lives outside that set. This module
//! spawns a one-shot login shell, captures its `env` output, and merges
//! the interesting variables into the current process so every child
//! (sidecar, git, workspace scripts) inherits them automatically.
//!
//! **Unix-only.** On Windows the GUI process already inherits the full
//! user environment — this module compiles to a no-op there.

/// Merge the user's login-shell environment into the current process.
///
/// Call this **once**, early in `setup`, before any child process is
/// spawned. It is intentionally infallible — on failure it logs and
/// returns, leaving the existing (minimal) environment in place.
pub fn inherit_login_shell_env() {
    #[cfg(unix)]
    unix::inherit();
}

#[cfg(unix)]
mod unix {
    use std::collections::HashMap;
    use std::process::Command;
    use std::time::Duration;

    /// How long we wait for the login shell to print `env` and exit.
    /// 5 seconds is generous — even heavy `.zshrc` files with nvm/rvm
    /// finish well within 3 s on modern hardware.
    const TIMEOUT: Duration = Duration::from_secs(5);

    /// Environment variables we copy from the login shell into the
    /// current process. `PATH` is the critical one; the rest are
    /// commonly needed by toolchains that child processes invoke.
    const VARS_TO_MERGE: &[&str] = &[
        "PATH",
        "NVM_DIR",
        "PNPM_HOME",
        "GOPATH",
        "GOROOT",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "DENO_INSTALL",
        "BUN_INSTALL",
        "JAVA_HOME",
        "ANDROID_HOME",
        "VOLTA_HOME",
        "FNM_DIR",
        // Homebrew — some formulas look at this rather than relying on
        // PATH alone.
        "HOMEBREW_PREFIX",
        "HOMEBREW_CELLAR",
        "HOMEBREW_REPOSITORY",
    ];

    pub fn inherit() {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        // Spawn a *login* shell (`-l`) that prints its full environment
        // and exits. We deliberately avoid `-i` (interactive) because that
        // may source `.inputrc`, start completion daemons, or wait for
        // terminal input — none of which we want.
        //
        // The command is:
        //   $SHELL -l -c '/usr/bin/env -0'
        //
        // `-0` (NUL-delimited) avoids ambiguity with multi-line values
        // (rare but possible, e.g. BASH_FUNC_*).
        let result = spawn_with_timeout(&shell, &["-l", "-c", "/usr/bin/env -0"], TIMEOUT);

        let output = match result {
            Ok(out) => out,
            Err(e) => {
                tracing::warn!(
                    shell,
                    error = %e,
                    "Failed to capture login-shell environment — \
                     child processes will use the minimal GUI PATH"
                );
                return;
            }
        };

        let env_map = parse_nul_delimited_env(&output);
        if env_map.is_empty() {
            tracing::warn!("Login-shell env capture returned no variables");
            return;
        }

        let mut merged = 0usize;
        for &var in VARS_TO_MERGE {
            if let Some(value) = env_map.get(var) {
                if var == "PATH" {
                    merge_path(value);
                } else {
                    // SAFETY: we're in `setup`, single-threaded.
                    unsafe { std::env::set_var(var, value) };
                }
                merged += 1;
            }
        }

        tracing::info!(
            merged,
            total_captured = env_map.len(),
            "Inherited login-shell environment"
        );
    }

    /// Merge the login shell's `PATH` with the current process `PATH`.
    ///
    /// Strategy: start from the login shell's PATH (which contains
    /// Homebrew, nvm, pnpm, cargo, etc.), then *append* any entries from
    /// the current PATH that aren't already present (e.g. Claude plugin
    /// directories that Helmor itself added).
    fn merge_path(login_path: &str) {
        let current = std::env::var("PATH").unwrap_or_default();

        // Collect login-shell entries as the base set.
        let mut seen: std::collections::HashSet<&str> = login_path.split(':').collect();
        let mut merged = login_path.to_string();

        // Append current-only entries.
        for entry in current.split(':') {
            if !entry.is_empty() && seen.insert(entry) {
                merged.push(':');
                merged.push_str(entry);
            }
        }

        tracing::debug!(
            login_entries = login_path.split(':').count(),
            current_entries = current.split(':').count(),
            merged_entries = merged.split(':').count(),
            "Merged PATH"
        );

        // SAFETY: single-threaded setup phase.
        unsafe { std::env::set_var("PATH", &merged) };
    }

    /// Spawn a process and wait for it with a timeout. Returns the
    /// captured stdout on success.
    fn spawn_with_timeout(
        program: &str,
        args: &[&str],
        timeout: Duration,
    ) -> anyhow::Result<Vec<u8>> {
        use std::io::Read;
        use std::os::unix::process::CommandExt;

        let mut child = Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            // Start in its own process group so we can kill it
            // without also signalling ourselves.
            .process_group(0)
            .spawn()
            .map_err(|e| anyhow::anyhow!("spawn `{program}`: {e}"))?;

        let pid = child.id();
        let deadline = std::time::Instant::now() + timeout;

        // Read stdout in a background thread so we can enforce the
        // timeout on the main thread.
        let mut stdout = child.stdout.take().unwrap();
        let reader = std::thread::Builder::new()
            .name("shell-env-reader".into())
            .spawn(move || {
                let mut buf = Vec::with_capacity(8 * 1024);
                stdout.read_to_end(&mut buf).ok();
                buf
            })?;

        // Poll for exit.
        let poll = Duration::from_millis(50);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        anyhow::bail!("`{program} -l -c env` exited with {status}");
                    }
                    return Ok(reader.join().unwrap_or_default());
                }
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        // Kill the process group, not just the shell.
                        unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
                        let _ = child.wait();
                        anyhow::bail!(
                            "login shell env capture timed out after {}s",
                            timeout.as_secs()
                        );
                    }
                    std::thread::sleep(poll);
                }
                Err(e) => anyhow::bail!("waitpid: {e}"),
            }
        }
    }

    /// Parse NUL-delimited `env -0` output into key/value pairs.
    fn parse_nul_delimited_env(data: &[u8]) -> HashMap<String, String> {
        let text = String::from_utf8_lossy(data);
        text.split('\0')
            .filter_map(|entry| {
                let (k, v) = entry.split_once('=')?;
                if k.is_empty() {
                    return None;
                }
                Some((k.to_string(), v.to_string()))
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parse_nul_env_basic() {
            let data = b"HOME=/Users/me\0PATH=/usr/bin:/bin\0SHELL=/bin/zsh\0";
            let map = parse_nul_delimited_env(data);
            assert_eq!(map.get("HOME").unwrap(), "/Users/me");
            assert_eq!(map.get("PATH").unwrap(), "/usr/bin:/bin");
            assert_eq!(map.get("SHELL").unwrap(), "/bin/zsh");
        }

        #[test]
        fn parse_nul_env_with_equals_in_value() {
            let data = b"FOO=bar=baz\0";
            let map = parse_nul_delimited_env(data);
            assert_eq!(map.get("FOO").unwrap(), "bar=baz");
        }

        #[test]
        fn parse_nul_env_empty() {
            let map = parse_nul_delimited_env(b"");
            assert!(map.is_empty());
        }

        #[test]
        fn merge_path_deduplicates() {
            // Simulate: login shell has /opt/homebrew/bin:/usr/bin
            // Current process has /usr/bin:/plugin/bin
            // Result should be: /opt/homebrew/bin:/usr/bin:/plugin/bin
            unsafe { std::env::set_var("PATH", "/usr/bin:/plugin/bin") };
            merge_path("/opt/homebrew/bin:/usr/bin");
            let result = std::env::var("PATH").unwrap();
            assert!(result.starts_with("/opt/homebrew/bin:/usr/bin"));
            assert!(result.contains("/plugin/bin"));
            // /usr/bin should appear only once
            assert_eq!(result.matches("/usr/bin").count(), 1);
        }
    }
}
