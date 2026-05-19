//! Best-effort hostname lookup for the server side.
//!
//! Surfaces in the `initialize` response and the daemon's startup
//! log; not load-bearing for correctness, so failures degrade to
//! `"unknown"` rather than propagating.

/// Read the hostname from the standard places. Prefers the
/// `HOSTNAME` env var when set (often pre-resolved by login
/// shells), falls back to `uname -n`, then a fixed sentinel so
/// the caller never has to deal with a `Result`.
pub fn read_hostname() -> String {
    if let Ok(host) = std::env::var("HOSTNAME") {
        if !host.is_empty() {
            return host;
        }
    }
    match std::process::Command::new("uname").arg("-n").output() {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_hostname_returns_a_nonempty_string() {
        // We can't pin the value (varies per machine + CI), but the
        // function must never return empty — that'd render the
        // initialize handshake's `hostname` field meaningless.
        let h = read_hostname();
        assert!(!h.is_empty());
    }

    #[test]
    fn read_hostname_honors_env_override() {
        // Save/restore so we don't pollute neighbouring tests in the
        // same process.
        let prior = std::env::var("HOSTNAME").ok();
        std::env::set_var("HOSTNAME", "test-host-from-env");
        let h = read_hostname();
        assert_eq!(h, "test-host-from-env");
        match prior {
            Some(v) => std::env::set_var("HOSTNAME", v),
            None => std::env::remove_var("HOSTNAME"),
        }
    }
}
