//! Per-source health detection (Connected / NotInstalled / NotAuthed / NotConfigured) for the Settings → Triage panel.

use std::io::ErrorKind;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::time::timeout;

use crate::models::repos;
use crate::models::slack_workspaces;
use crate::triage::fetcher::health::FetchHealth;

const LARK_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceHealthState {
    Ok,
    /// CLI binary missing on PATH (Lark only).
    NotInstalled,
    /// CLI / workspace present but no usable login.
    NotAuthed,
    /// Auth OK but no repos/workspaces to fetch from.
    NotConfigured,
    /// Auth OK but the most recent fetch failed or returned partial data.
    Degraded,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    pub source: &'static str,
    pub display_name: &'static str,
    pub state: SourceHealthState,
    /// Actionable one-line hint shown under the source row.
    pub detail: String,
}

pub async fn detect_all() -> Vec<SourceHealth> {
    // Order is part of the UX contract: GitHub, GitLab, Slack, Lark.
    let lark = detect_lark().await;
    // GitHub / GitLab / Slack probes are sync-only; run them on the
    // blocking pool so a slow forge CLI doesn't park the async runtime.
    let forges_and_slack = tauri::async_runtime::spawn_blocking(|| {
        vec![detect_github(), detect_gitlab(), detect_slack()]
    })
    .await
    .unwrap_or_default();
    let mut out = forges_and_slack;
    out.push(lark);
    out
}

async fn detect_lark() -> SourceHealth {
    // Phase 1: PATH probe.
    let spawn = Command::new("lark-cli")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match spawn {
        Ok(c) => c,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return SourceHealth {
                source: "lark",
                display_name: "Lark",
                state: SourceHealthState::NotInstalled,
                detail: "Install `lark-cli`".into(),
            };
        }
        Err(_) => {
            return SourceHealth {
                source: "lark",
                display_name: "Lark",
                state: SourceHealthState::NotInstalled,
                detail: "Install `lark-cli`".into(),
            };
        }
    };
    if timeout(LARK_PROBE_TIMEOUT, child.wait()).await.is_err() {
        let _ = child.kill().await;
        return SourceHealth {
            source: "lark",
            display_name: "Lark",
            state: SourceHealthState::NotInstalled,
            detail: "lark-cli not responding".into(),
        };
    }

    // Phase 2: installed → does `auth status` succeed?
    match crate::lark::auth_status().await {
        Ok(()) => SourceHealth {
            source: "lark",
            display_name: "Lark",
            state: SourceHealthState::Ok,
            detail: "Watching active chats".into(),
        },
        Err(_) => SourceHealth {
            source: "lark",
            display_name: "Lark",
            state: SourceHealthState::NotAuthed,
            detail: "Run `lark-cli auth login`".into(),
        },
    }
}

fn detect_slack() -> SourceHealth {
    let workspaces = slack_workspaces::list_workspaces().unwrap_or_default();
    resolve_slack_health(
        workspaces.len(),
        crate::triage::fetcher::health::get("slack"),
    )
}

/// Pure core: combine the static "is a workspace connected" signal with
/// the runtime fetch-health overlay. Split out so it's unit-testable
/// without touching the process-global health store.
fn resolve_slack_health(n_workspaces: usize, health: Option<FetchHealth>) -> SourceHealth {
    if n_workspaces == 0 {
        return SourceHealth {
            source: "slack",
            display_name: "Slack",
            state: SourceHealthState::NotAuthed,
            detail: "No workspace connected".into(),
        };
    }
    // A hard failure on the most recent tick, or a partial degradation,
    // overrides the otherwise-green "watching" status so the user sees it
    // instead of the panel silently claiming everything is fine.
    if let Some(h) = health {
        if let Some(error) = h.last_error.as_deref() {
            return SourceHealth {
                source: "slack",
                display_name: "Slack",
                state: SourceHealthState::Degraded,
                detail: format!("Last fetch failed: {}", short_reason(error)),
            };
        }
        if let Some(degraded) = h.last_degraded.as_deref() {
            return SourceHealth {
                source: "slack",
                display_name: "Slack",
                state: SourceHealthState::Degraded,
                detail: short_reason(degraded),
            };
        }
    }
    let n = n_workspaces;
    SourceHealth {
        source: "slack",
        display_name: "Slack",
        state: SourceHealthState::Ok,
        detail: format!("Watching {n} workspace{}", if n == 1 { "" } else { "s" }),
    }
}

/// First line, trimmed and capped, so a multi-line anyhow chain stays a
/// single readable row in the panel.
fn short_reason(reason: &str) -> String {
    let line = reason.lines().next().unwrap_or(reason).trim();
    const MAX: usize = 140;
    if line.chars().count() <= MAX {
        line.to_string()
    } else {
        let mut out: String = line.chars().take(MAX).collect();
        out.push('…');
        out
    }
}

fn detect_github() -> SourceHealth {
    detect_forge("github", "GitHub", "gh auth login")
}

fn detect_gitlab() -> SourceHealth {
    detect_forge("gitlab", "GitLab", "glab auth login")
}

fn detect_forge(source: &'static str, display_name: &'static str, auth_hint: &str) -> SourceHealth {
    let repos = repos::list_repositories().unwrap_or_default();
    let provider_repos: Vec<_> = repos
        .iter()
        .filter(|r| r.forge_provider.as_deref() == Some(source))
        .collect();
    if provider_repos.is_empty() {
        return SourceHealth {
            source,
            display_name,
            state: SourceHealthState::NotConfigured,
            detail: format!("Add a {display_name} repo"),
        };
    }
    let any_login = provider_repos
        .iter()
        .any(|r| r.forge_login.as_deref().is_some_and(|s| !s.is_empty()));
    if !any_login {
        return SourceHealth {
            source,
            display_name,
            state: SourceHealthState::NotAuthed,
            detail: format!("Run `{auth_hint}`"),
        };
    }
    let n = provider_repos.len();
    SourceHealth {
        source,
        display_name,
        state: SourceHealthState::Ok,
        detail: format!("Watching {n} repo{}", if n == 1 { "" } else { "s" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_workspace_is_not_authed() {
        let h = resolve_slack_health(0, None);
        assert_eq!(h.state, SourceHealthState::NotAuthed);
    }

    #[test]
    fn healthy_workspace_is_ok() {
        let h = resolve_slack_health(2, None);
        assert_eq!(h.state, SourceHealthState::Ok);
        assert!(h.detail.contains("2 workspaces"));
    }

    #[test]
    fn last_error_surfaces_as_degraded_single_line() {
        let health = FetchHealth {
            last_error: Some(
                "users.conversations failed: connection refused\ntrailing noise".into(),
            ),
            ..Default::default()
        };
        let h = resolve_slack_health(1, Some(health));
        assert_eq!(h.state, SourceHealthState::Degraded);
        assert!(h.detail.starts_with("Last fetch failed:"));
        assert!(!h.detail.contains('\n'));
    }

    #[test]
    fn partial_degradation_surfaces_as_degraded() {
        let health = FetchHealth {
            last_degraded: Some("channel discovery degraded (mention: 503)".into()),
            ..Default::default()
        };
        let h = resolve_slack_health(1, Some(health));
        assert_eq!(h.state, SourceHealthState::Degraded);
    }

    #[test]
    fn hard_error_takes_precedence_over_partial_degradation() {
        let health = FetchHealth {
            last_error: Some("boom".into()),
            last_degraded: Some("partial".into()),
            ..Default::default()
        };
        let h = resolve_slack_health(1, Some(health));
        assert!(h.detail.starts_with("Last fetch failed:"));
    }
}
