//! Per-source health detection for the Settings → Triage panel.
//!
//! Each fetcher auto-enables based on whether the underlying CLI /
//! workspace is connected. Users still need to see WHY a source isn't
//! producing candidates — which is the whole point of this module.
//!
//! Three states surface to the UI:
//!   - `Ok` → fetcher will run for this source.
//!   - `NotInstalled` → required CLI binary missing (Lark only — `gh`
//!     and `glab` are bundled).
//!   - `NotAuthed` → CLI / workspace present but no usable login.
//!   - `NotConfigured` → no Helmor repos or Slack workspaces wired up,
//!     so even with auth there's nothing to fetch.
//!
//! Detection is best-effort and time-bounded — a flaky CLI shouldn't
//! make the Settings panel hang.

use std::io::ErrorKind;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::time::timeout;

use crate::models::repos;
use crate::models::slack_workspaces;

const LARK_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceHealthState {
    Ok,
    /// Required CLI binary is not on PATH. User must install it (e.g.
    /// `brew install lark-cli`). Currently only Lark — `gh` and `glab`
    /// ship inside Helmor.
    NotInstalled,
    /// CLI / workspace present but no usable login.
    NotAuthed,
    /// Auth fine but nothing for the fetcher to pull (no repos / no
    /// workspaces). Hidden separately so the user knows it's not an
    /// auth bug.
    NotConfigured,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    pub source: &'static str,
    pub display_name: &'static str,
    pub state: SourceHealthState,
    /// Free-form hint shown under the source row. Keep it actionable
    /// (one short sentence, ideally with the command to run).
    pub detail: String,
}

pub async fn detect_all() -> Vec<SourceHealth> {
    // Order is part of the UX contract — the Settings panel renders
    // these top-to-bottom: GitHub, GitLab, Slack, Lark. Code-first
    // sources first, then chat.
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
    // Phase 1: is the binary on PATH? `--version` is the cheapest probe
    // and works without auth.
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
    if workspaces.is_empty() {
        return SourceHealth {
            source: "slack",
            display_name: "Slack",
            state: SourceHealthState::NotAuthed,
            detail: "Connect in Settings → Slack".into(),
        };
    }
    let n = workspaces.len();
    SourceHealth {
        source: "slack",
        display_name: "Slack",
        state: SourceHealthState::Ok,
        detail: format!("Watching {n} workspace{}", if n == 1 { "" } else { "s" }),
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
