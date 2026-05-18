//! Connection configuration for registered runtimes.
//!
//! Captures *what's needed to reconnect* a remote without ever
//! capturing credentials. The local-binary variant holds an optional
//! filesystem path; the SSH variant holds the host + remote binary
//! name. Anything auth-shaped (keys, passwords, agent state) is
//! delegated to `ssh` itself.
//!
//! Lives next to [`super::registry`] but in its own module so the
//! persistence layer in [`super::persistence`] can depend on the
//! shape without also pulling the registry's runtime machinery.

use serde::{Deserialize, Serialize};

/// How a registered runtime was constructed. The command layer
/// stashes one of these on the registry entry so the persistence
/// loop knows how to recreate the connection at next boot.
///
/// Wire-friendly so it serialises straight to
/// `<data_dir>/remote_runtimes.json` without an intermediate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeConnectionConfig {
    /// Spawn `helmor-server` directly as a local child process.
    /// `binary_path` is `None` for the auto-detect path (env var or
    /// `<exe_dir>/helmor-server`).
    Local {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binary_path: Option<String>,
    },
    /// Spawn `ssh <host> <remote_binary>`. Auth is whatever the
    /// system ssh-agent / key files provide — the spike intentionally
    /// doesn't try to manage credentials.
    Ssh { host: String, remote_binary: String },
    /// Spawn an arbitrary `argv`. Used for transports like Teleport
    /// (`tsh ssh host helmor-server --proxy`), Tailscale SSH
    /// (`tailscale ssh host helmor-server --proxy`), or
    /// `kubectl exec`-based dev pods. The argv list is handed to
    /// `Command` verbatim — no shell tokenisation — so quoting hazards
    /// don't apply. Auto-install is out of scope for this transport;
    /// the operator is expected to have `helmor-server` already
    /// installed on the remote side.
    Command { argv: Vec<String> },
}

impl RuntimeConnectionConfig {
    /// Short human-readable label for log lines / chip tooltips.
    /// Not stable wire shape; just for diagnostics.
    pub fn describe(&self) -> String {
        match self {
            Self::Local { binary_path: None } => "local: auto-detect".to_string(),
            Self::Local {
                binary_path: Some(p),
            } => format!("local: {p}"),
            Self::Ssh {
                host,
                remote_binary,
            } => format!("ssh: {host} {remote_binary}"),
            Self::Command { argv } => {
                // Join with spaces for the label only — the underlying
                // transport never shell-tokenises argv, so a label
                // with spaces is unambiguous in context (the form
                // shows the literal argv list next to it). Single
                // quotes around tokens with whitespace keep the label
                // copy-pasteable into a debug log without ambiguity.
                let joined = argv
                    .iter()
                    .map(|s| {
                        if s.contains(char::is_whitespace) {
                            format!("'{s}'")
                        } else {
                            s.clone()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("cmd: {joined}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_variant_serialises_with_camel_case_tag() {
        let cfg = RuntimeConnectionConfig::Local {
            binary_path: Some("/usr/local/bin/helmor-server".into()),
        };
        let wire = serde_json::to_string(&cfg).unwrap();
        assert!(wire.contains("\"type\":\"local\""));
        assert!(wire.contains("\"binaryPath\""));
    }

    #[test]
    fn local_variant_omits_binary_path_when_none() {
        let cfg = RuntimeConnectionConfig::Local { binary_path: None };
        let wire = serde_json::to_string(&cfg).unwrap();
        assert!(wire.contains("\"type\":\"local\""));
        assert!(
            !wire.contains("binaryPath"),
            "absent binaryPath should be skipped: {wire}"
        );
    }

    #[test]
    fn ssh_variant_round_trips_through_serde() {
        let cfg = RuntimeConnectionConfig::Ssh {
            host: "dev.box".into(),
            remote_binary: "helmor-server".into(),
        };
        let wire = serde_json::to_string(&cfg).unwrap();
        let restored: RuntimeConnectionConfig = serde_json::from_str(&wire).unwrap();
        assert_eq!(cfg, restored);
    }

    #[test]
    fn describe_renders_distinct_strings_per_variant() {
        let a = RuntimeConnectionConfig::Local { binary_path: None }.describe();
        let b = RuntimeConnectionConfig::Local {
            binary_path: Some("/tmp/server".into()),
        }
        .describe();
        let c = RuntimeConnectionConfig::Ssh {
            host: "x".into(),
            remote_binary: "y".into(),
        }
        .describe();
        let d = RuntimeConnectionConfig::Command {
            argv: vec!["tsh".into(), "ssh".into()],
        }
        .describe();
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
        assert_ne!(c, d);
    }

    #[test]
    fn command_variant_serialises_with_camel_case_tag_and_argv_array() {
        let cfg = RuntimeConnectionConfig::Command {
            argv: vec![
                "tsh".into(),
                "ssh".into(),
                "host".into(),
                "helmor-server".into(),
                "--proxy".into(),
            ],
        };
        let wire = serde_json::to_value(&cfg).unwrap();
        assert_eq!(wire["type"], "command");
        let argv = wire["argv"].as_array().expect("argv is an array");
        assert_eq!(argv.len(), 5);
        assert_eq!(argv[0], "tsh");
        assert_eq!(argv[4], "--proxy");
    }

    #[test]
    fn command_variant_round_trips_through_serde() {
        let cfg = RuntimeConnectionConfig::Command {
            argv: vec![
                "tailscale".into(),
                "ssh".into(),
                "dev-box".into(),
                "helmor-server".into(),
                "--proxy".into(),
            ],
        };
        let wire = serde_json::to_string(&cfg).unwrap();
        let restored: RuntimeConnectionConfig = serde_json::from_str(&wire).unwrap();
        assert_eq!(cfg, restored);
    }

    #[test]
    fn command_variant_describe_quotes_tokens_with_whitespace() {
        // A label with a space in a token would be ambiguous when
        // copy-pasted from a log — single-quote those tokens so the
        // boundary is visible.
        let cfg = RuntimeConnectionConfig::Command {
            argv: vec!["ssh".into(), "user@host with space".into(), "cmd".into()],
        };
        let label = cfg.describe();
        assert!(label.contains("'user@host with space'"), "{label}");
        assert!(label.starts_with("cmd: "), "{label}");
    }
}
