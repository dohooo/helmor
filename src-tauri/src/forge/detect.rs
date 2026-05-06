//! Layered forge detection.
//!
//! Runs a chain of progressively more expensive checks against a git
//! remote URL (and optionally the repo root) to classify it as GitHub /
//! GitLab / Unknown. Each layer that fires contributes a human-readable
//! `DetectionSignal` so the UI can explain *why* we picked a provider.
//!
//! Layer order (cheapest → strongest, short-circuits on first confident
//! hit):
//!
//! 1. Well-known hosts (`github.com`, `gitlab.com`, …).
//! 2. Host prefix/suffix heuristics (`gitlab.*`, `*.ghe.com`, …).
//! 3. URL path heuristics (`/-/` is GitLab-exclusive).
//! 4. Repo-root filesystem signals (`.gitlab-ci.yml`, `.github/workflows/`).
//! 5. HTTPS probe (`/api/v4/version` for GitLab, `/api/v3/` for GH Enterprise).
//! 6. CLI probe (`glab repo view` / `gh repo view`) when the CLI is present.

use std::path::Path;
use std::time::Duration;

use super::cli_status::labels_for;
use super::command::{command_detail, run_command_with_timeout};
use super::remote::{parse_remote, ParsedRemote};
use super::types::{DetectionSignal, ForgeDetection, ForgeProvider};

const CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Detect a forge provider for a repo at creation time.
///
/// Returns (`provider`, `signals`) so callers can both persist the
/// classification and show the user which layer fired.
pub fn detect_provider_for_repo(
    remote_url: Option<&str>,
    repo_root: Option<&Path>,
) -> (ForgeProvider, Vec<DetectionSignal>) {
    detect_provider_for_repo_impl(remote_url, repo_root, true)
}

pub(crate) fn detect_provider_for_repo_offline(
    remote_url: Option<&str>,
    repo_root: Option<&Path>,
) -> (ForgeProvider, Vec<DetectionSignal>) {
    detect_provider_for_repo_impl(remote_url, repo_root, false)
}

fn detect_provider_for_repo_impl(
    remote_url: Option<&str>,
    repo_root: Option<&Path>,
    allow_expensive_probes: bool,
) -> (ForgeProvider, Vec<DetectionSignal>) {
    let Some(url) = remote_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return (ForgeProvider::Unknown, Vec::new());
    };
    let parsed = parse_remote(url);
    let mut signals: Vec<DetectionSignal> = Vec::new();

    // Layer 1 — well-known hosts.
    if let Some(remote) = parsed.as_ref() {
        let host = remote.host.as_str();
        if matches_wellknown_github(host) {
            signals.push(DetectionSignal {
                layer: "wellKnownHost",
                detail: format!("Host `{host}` is a well-known GitHub host"),
            });
            return (ForgeProvider::Github, signals);
        }
        if matches_wellknown_gitlab(host) {
            signals.push(DetectionSignal {
                layer: "wellKnownHost",
                detail: format!("Host `{host}` is a well-known GitLab host"),
            });
            return (ForgeProvider::Gitlab, signals);
        }
    }

    // Layer 2 — host prefix/suffix heuristics.
    if let Some(remote) = parsed.as_ref() {
        let host = remote.host.as_str();
        if host_looks_like_github(host) {
            signals.push(DetectionSignal {
                layer: "hostPattern",
                detail: format!("Host `{host}` matches a GitHub naming pattern"),
            });
            // Hostname patterns alone aren't conclusive for GH Enterprise —
            // keep collecting signals, but treat this as provisional.
        } else if host_looks_like_gitlab(host) {
            signals.push(DetectionSignal {
                layer: "hostPattern",
                detail: format!("Host `{host}` matches a GitLab naming pattern"),
            });
        }
    }

    // Layer 3 — URL path heuristics. `/-/` is unique to GitLab's routing.
    if let Some(remote) = parsed.as_ref() {
        if remote.path.contains("/-/") {
            signals.push(DetectionSignal {
                layer: "urlPath",
                detail: "URL path contains `/-/`, which is GitLab-specific".to_string(),
            });
            return (ForgeProvider::Gitlab, signals);
        }
    }

    // Layer 4 — repo-root filesystem signals.
    if let Some(root) = repo_root {
        if root.join(".gitlab-ci.yml").is_file() {
            signals.push(DetectionSignal {
                layer: "repoFile",
                detail: "`.gitlab-ci.yml` present at repo root".to_string(),
            });
        }
        if root.join(".github").join("workflows").is_dir() {
            signals.push(DetectionSignal {
                layer: "repoFile",
                detail: "`.github/workflows/` present at repo root".to_string(),
            });
        }
    }

    // If Layer 2 + Layer 4 combined give us a consistent read, trust it
    // before burning a network/CLI probe.
    if let Some(resolved) = resolve_from_signals(&signals) {
        return (resolved, signals);
    }

    if !allow_expensive_probes {
        return (ForgeProvider::Unknown, signals);
    }

    // Layer 5 — HTTPS probe (best-effort, short timeout).
    if let Some(remote) = parsed.as_ref() {
        if let Some(signal) = probe_gitlab_api(&remote.host) {
            signals.push(signal);
            return (ForgeProvider::Gitlab, signals);
        }
        if let Some(signal) = probe_github_api(&remote.host) {
            signals.push(signal);
            return (ForgeProvider::Github, signals);
        }
    }

    // Layer 6 — CLI probe (requires CLI installed).
    if let Some(remote) = parsed.as_ref() {
        if glab_recognizes_remote(remote) {
            signals.push(DetectionSignal {
                layer: "cliProbe",
                detail: "`glab repo view` recognized the remote".to_string(),
            });
            return (ForgeProvider::Gitlab, signals);
        }
        if gh_recognizes_remote(remote) {
            signals.push(DetectionSignal {
                layer: "cliProbe",
                detail: "`gh repo view` recognized the remote".to_string(),
            });
            return (ForgeProvider::Github, signals);
        }
    }

    if let Some(resolved) = resolve_from_signals(&signals) {
        return (resolved, signals);
    }

    (ForgeProvider::Unknown, signals)
}

/// If the collected signals unambiguously point at one forge (no
/// contradictions), trust them without another probe.
fn resolve_from_signals(signals: &[DetectionSignal]) -> Option<ForgeProvider> {
    let mentions_gitlab = signals
        .iter()
        .any(|s| s.detail.to_ascii_lowercase().contains("gitlab"));
    let mentions_github = signals
        .iter()
        .any(|s| s.detail.to_ascii_lowercase().contains("github"));
    match (mentions_gitlab, mentions_github) {
        (true, false) => Some(ForgeProvider::Gitlab),
        (false, true) => Some(ForgeProvider::Github),
        _ => None,
    }
}

/// Assemble the full `ForgeDetection` payload the frontend consumes.
/// Prefers a previously-stored provider (persisted at repo-creation time);
/// falls back to re-running the layered detector when there is none.
pub(crate) fn build_detection_for_remote(
    remote_url: Option<&str>,
    stored_provider: Option<ForgeProvider>,
    repo_root: Option<&Path>,
) -> ForgeDetection {
    let parsed = remote_url.and_then(parse_remote);
    let (provider, signals) = match stored_provider {
        Some(p) if p != ForgeProvider::Unknown => (p, Vec::new()),
        _ => detect_provider_for_repo(remote_url, repo_root),
    };

    ForgeDetection {
        provider,
        host: parsed.as_ref().map(|r| r.host.clone()),
        namespace: parsed.as_ref().map(|r| r.namespace.clone()),
        repo: parsed.as_ref().map(|r| r.repo.clone()),
        remote_url: remote_url.map(str::to_string),
        labels: labels_for(provider),
        detection_signals: signals,
    }
}

fn matches_wellknown_github(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "github.com" | "www.github.com" | "gist.github.com" | "api.github.com"
    )
}

fn matches_wellknown_gitlab(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "gitlab.com" | "www.gitlab.com" | "salsa.debian.org" | "framagit.org" | "invent.kde.org"
    )
}

fn host_looks_like_github(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host.starts_with("github.")
        || host.ends_with(".github.com")
        || host.ends_with(".ghe.com")
        || host.ends_with(".ghe.io")
}

fn host_looks_like_gitlab(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host.starts_with("gitlab.")
        || host.ends_with(".gitlab.com")
        || host.ends_with(".gitlab.io")
        || host.split('.').any(|segment| segment == "gitlab")
}

/// Short-timeout GET against GitLab's `/api/v4/version`. A 200/401 with a
/// GitLab server header is a strong positive; anything else is
/// inconclusive, so we return None and let the next layer try.
fn probe_gitlab_api(host: &str) -> Option<DetectionSignal> {
    let client = build_probe_client()?;
    let url = format!("https://{host}/api/v4/version");
    let response = client.get(&url).send().ok()?;
    let status = response.status();
    let server = response
        .headers()
        .get("server")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let has_gitlab_header = response
        .headers()
        .keys()
        .any(|k| k.as_str().to_ascii_lowercase().starts_with("x-gitlab"));
    if has_gitlab_header || server.contains("gitlab") {
        return Some(DetectionSignal {
            layer: "httpProbe",
            detail: format!("`{url}` responded with a GitLab signature"),
        });
    }
    if status.is_success() || status == reqwest::StatusCode::UNAUTHORIZED {
        // `/api/v4/version` is a GitLab-specific path; a 401 here almost
        // certainly means we hit a real GitLab instance that wants a token.
        return Some(DetectionSignal {
            layer: "httpProbe",
            detail: format!("`{url}` returned {status} — GitLab API shape"),
        });
    }
    None
}

fn probe_github_api(host: &str) -> Option<DetectionSignal> {
    let client = build_probe_client()?;
    let url = format!("https://{host}/api/v3/");
    let response = client.get(&url).send().ok()?;
    let has_github_header = response
        .headers()
        .keys()
        .any(|k| k.as_str().to_ascii_lowercase().starts_with("x-github"));
    if has_github_header {
        return Some(DetectionSignal {
            layer: "httpProbe",
            detail: format!("`{url}` responded with X-GitHub-* headers"),
        });
    }
    None
}

fn build_probe_client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent("helmor-forge-probe/1.0")
        .timeout(Duration::from_millis(1500))
        .connect_timeout(Duration::from_millis(800))
        .build()
        .ok()
}

fn glab_recognizes_remote(remote: &ParsedRemote) -> bool {
    if run_command_with_timeout("glab", ["--version"], CLI_PROBE_TIMEOUT).is_err() {
        return false;
    }
    let repo_path = format!("{}/{}", remote.namespace, remote.repo);
    match run_command_with_timeout(
        "glab",
        [
            "repo",
            "view",
            repo_path.as_str(),
            "--hostname",
            remote.host.as_str(),
        ],
        CLI_PROBE_TIMEOUT,
    ) {
        Ok(output) if output.success => true,
        Ok(output) => looks_like_glab_unauthenticated(&command_detail(&output)),
        Err(_) => false,
    }
}

fn gh_recognizes_remote(remote: &ParsedRemote) -> bool {
    if run_command_with_timeout("gh", ["--version"], CLI_PROBE_TIMEOUT).is_err() {
        return false;
    }
    let repo_path = format!("{}/{}", remote.namespace, remote.repo);
    match run_command_with_timeout(
        "gh",
        [
            "repo",
            "view",
            repo_path.as_str(),
            "--hostname",
            remote.host.as_str(),
            "--json",
            "name",
        ],
        CLI_PROBE_TIMEOUT,
    ) {
        Ok(output) if output.success => true,
        Ok(output) => {
            let detail = command_detail(&output).to_ascii_lowercase();
            // `gh` without auth against a valid host still parses the repo
            // correctly; we take "authentication" errors as positive.
            detail.contains("authentication")
                || detail.contains("not logged in")
                || detail.contains("gh auth login")
        }
        Err(_) => false,
    }
}

fn looks_like_glab_unauthenticated(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("not logged in")
        || normalized.contains("not authenticated")
        || normalized.contains("authentication")
        || normalized.contains("glab auth login")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_github_host_detected_offline() {
        let (provider, signals) =
            detect_provider_for_repo(Some("https://github.com/octocat/hi.git"), None);
        assert_eq!(provider, ForgeProvider::Github);
        assert_eq!(signals.first().map(|s| s.layer), Some("wellKnownHost"));
    }

    #[test]
    fn well_known_gitlab_host_detected_offline() {
        let (provider, signals) =
            detect_provider_for_repo(Some("git@gitlab.com:group/proj.git"), None);
        assert_eq!(provider, ForgeProvider::Gitlab);
        assert_eq!(signals.first().map(|s| s.layer), Some("wellKnownHost"));
    }

    #[test]
    fn self_hosted_gitlab_detected_via_host_pattern_without_glab() {
        // Without glab installed, the layered detector must still classify
        // a `gitlab.<company>.com` host as GitLab via Layer 2.
        let (provider, signals) =
            detect_provider_for_repo(Some("git@gitlab.mycorp.com:team/svc.git"), None);
        assert_eq!(provider, ForgeProvider::Gitlab);
        assert!(signals.iter().any(|s| s.layer == "hostPattern"));
    }

    #[test]
    fn self_hosted_github_enterprise_detected_via_host_pattern() {
        let (provider, signals) =
            detect_provider_for_repo(Some("git@github.enterprise.corp:team/svc.git"), None);
        assert_eq!(provider, ForgeProvider::Github);
        assert!(signals.iter().any(|s| s.layer == "hostPattern"));
    }

    #[test]
    fn url_path_dash_segment_signals_gitlab() {
        let (provider, signals) = detect_provider_for_repo(
            Some("https://code.example.com/group/proj/-/tree/main"),
            None,
        );
        assert_eq!(provider, ForgeProvider::Gitlab);
        assert!(signals.iter().any(|s| s.layer == "urlPath"));
    }

    #[test]
    fn empty_or_missing_remote_yields_unknown() {
        let (provider, signals) = detect_provider_for_repo(None, None);
        assert_eq!(provider, ForgeProvider::Unknown);
        assert!(signals.is_empty());
        let (provider, _) = detect_provider_for_repo(Some(""), None);
        assert_eq!(provider, ForgeProvider::Unknown);
    }

    #[test]
    fn gitlab_ci_yml_supplies_file_signal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitlab-ci.yml"), b"stages: []").unwrap();
        let (provider, signals) =
            detect_provider_for_repo(Some("git@code.example.com:team/svc.git"), Some(dir.path()));
        assert_eq!(provider, ForgeProvider::Gitlab);
        assert!(signals.iter().any(|s| s.layer == "repoFile"));
    }

    #[test]
    fn workspace_detection_reruns_when_cached_provider_is_missing() {
        let detection = build_detection_for_remote(
            Some("git@gitlab.internal.example:team/svc.git"),
            None,
            None,
        );

        assert_eq!(detection.provider, ForgeProvider::Gitlab);
        assert!(detection
            .detection_signals
            .iter()
            .any(|signal| signal.layer == "hostPattern"));
    }

    #[test]
    fn workspace_detection_reruns_when_cached_provider_is_unknown() {
        let detection = build_detection_for_remote(
            Some("git@github.enterprise.example:team/svc.git"),
            Some(ForgeProvider::Unknown),
            None,
        );

        assert_eq!(detection.provider, ForgeProvider::Github);
        assert!(detection
            .detection_signals
            .iter()
            .any(|signal| signal.layer == "hostPattern"));
    }

    #[test]
    fn workspace_detection_prefers_concrete_cached_provider() {
        let detection = build_detection_for_remote(
            Some("git@gitlab.internal.example:team/svc.git"),
            Some(ForgeProvider::Github),
            None,
        );

        assert_eq!(detection.provider, ForgeProvider::Github);
        assert!(detection.detection_signals.is_empty());
    }
}
