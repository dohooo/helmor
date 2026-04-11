use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const GITHUB_HOST: &str = "github.com";
const GITHUB_REPOS_ENDPOINT: &str =
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member";
const GITHUB_CLI_STATUS_CACHE_TTL: Duration = Duration::from_secs(2);

static SYSTEM_GH_STATUS_CACHE: LazyLock<Mutex<Option<CachedGithubCliStatus>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum GithubCliStatus {
    Ready {
        host: String,
        login: String,
        version: String,
        message: String,
    },
    Unauthenticated {
        host: String,
        version: Option<String>,
        message: String,
    },
    Unavailable {
        host: String,
        message: String,
    },
    Error {
        host: String,
        version: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubCliUser {
    pub login: String,
    pub id: i64,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositorySummary {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub owner_login: String,
    pub private: bool,
    pub default_branch: Option<String>,
    pub html_url: String,
    pub updated_at: Option<String>,
    pub pushed_at: Option<String>,
}

#[derive(Debug, Clone)]
struct GhCommandOutput {
    stdout: String,
}

#[derive(Debug, Clone)]
enum GhCommandError {
    NotFound,
    Failed {
        stdout: String,
        stderr: String,
        code: Option<i32>,
    },
    Other(String),
}

trait GhCommandRunner {
    fn run<I, S>(&self, args: I) -> std::result::Result<GhCommandOutput, GhCommandError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>;
}

#[derive(Debug, Clone)]
struct CachedGithubCliStatus {
    cached_at: Instant,
    status: GithubCliStatus,
}

pub fn get_github_cli_status() -> Result<GithubCliStatus> {
    load_cached_system_github_cli_status()
}

pub fn get_github_cli_user() -> Result<Option<GithubCliUser>> {
    let status = load_cached_system_github_cli_status()?;
    get_github_cli_user_with_status(&SystemGhRunner, &status)
}

pub fn list_github_accessible_repositories() -> Result<Vec<GithubRepositorySummary>> {
    let status = load_cached_system_github_cli_status()?;
    list_github_accessible_repositories_with_status(&SystemGhRunner, &status)
}

fn get_github_cli_status_with(runner: &impl GhCommandRunner) -> Result<GithubCliStatus> {
    let version = match runner.run(["--version"]) {
        Ok(output) => Some(parse_gh_version(&output.stdout)),
        Err(GhCommandError::NotFound) => {
            return Ok(GithubCliStatus::Unavailable {
                host: GITHUB_HOST.to_string(),
                message: "GitHub CLI is not installed on this machine.".to_string(),
            });
        }
        Err(GhCommandError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            return Ok(GithubCliStatus::Error {
                host: GITHUB_HOST.to_string(),
                version: None,
                message: format!(
                    "Unable to read GitHub CLI version: {}",
                    command_error_detail(&stdout, &stderr, code)
                ),
            });
        }
        Err(GhCommandError::Other(message)) => {
            return Ok(GithubCliStatus::Error {
                host: GITHUB_HOST.to_string(),
                version: None,
                message: format!("Unable to read GitHub CLI version: {message}"),
            });
        }
    };

    let auth_output = match runner.run([
        "auth",
        "status",
        "--hostname",
        GITHUB_HOST,
        "--json",
        "hosts",
    ]) {
        Ok(output) => output,
        Err(GhCommandError::NotFound) => {
            return Ok(GithubCliStatus::Unavailable {
                host: GITHUB_HOST.to_string(),
                message: "GitHub CLI is not installed on this machine.".to_string(),
            });
        }
        Err(GhCommandError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            let detail = command_error_detail(&stdout, &stderr, code);
            if looks_like_unauthenticated(&detail) {
                return Ok(GithubCliStatus::Unauthenticated {
                    host: GITHUB_HOST.to_string(),
                    version,
                    message: "Run `gh auth login` to connect GitHub CLI.".to_string(),
                });
            }

            return Ok(GithubCliStatus::Error {
                host: GITHUB_HOST.to_string(),
                version,
                message: format!("GitHub CLI auth check failed: {detail}"),
            });
        }
        Err(GhCommandError::Other(message)) => {
            return Ok(GithubCliStatus::Error {
                host: GITHUB_HOST.to_string(),
                version,
                message: format!("GitHub CLI auth check failed: {message}"),
            });
        }
    };

    let parsed = serde_json::from_str::<GhAuthStatusResponse>(&auth_output.stdout)
        .context("Failed to decode GitHub CLI auth status")?;
    let host_entry = parsed
        .hosts
        .get(GITHUB_HOST)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.active.unwrap_or(false))
                .or_else(|| entries.first())
        })
        .cloned()
        .context("GitHub CLI did not return auth status for github.com")?;

    let host = host_entry.host.unwrap_or_else(|| GITHUB_HOST.to_string());
    let login = host_entry.login.unwrap_or_default();

    if host_entry.state.as_deref() != Some("success") || login.trim().is_empty() {
        return Ok(GithubCliStatus::Unauthenticated {
            host,
            version,
            message: "Run `gh auth login` to connect GitHub CLI.".to_string(),
        });
    }

    Ok(GithubCliStatus::Ready {
        host,
        login: login.clone(),
        version: version.unwrap_or_else(|| "unknown".to_string()),
        message: format!("GitHub CLI ready as {login}."),
    })
}

#[cfg(test)]
fn get_github_cli_user_with(runner: &impl GhCommandRunner) -> Result<Option<GithubCliUser>> {
    let status = get_github_cli_status_with(runner)?;
    get_github_cli_user_with_status(runner, &status)
}

fn get_github_cli_user_with_status(
    runner: &impl GhCommandRunner,
    status: &GithubCliStatus,
) -> Result<Option<GithubCliUser>> {
    if !github_cli_is_ready(status) {
        return Ok(None);
    }

    let output = match runner.run(["api", "/user"]) {
        Ok(output) => output,
        Err(GhCommandError::NotFound) => return Ok(None),
        Err(GhCommandError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            let detail = command_error_detail(&stdout, &stderr, code);
            if looks_like_unauthenticated(&detail) {
                return Ok(None);
            }

            return Err(anyhow!("GitHub CLI user lookup failed: {detail}"));
        }
        Err(GhCommandError::Other(message)) => {
            return Err(anyhow!("GitHub CLI user lookup failed: {message}"));
        }
    };

    let parsed = serde_json::from_str::<GithubApiUser>(&output.stdout)
        .context("Failed to decode GitHub CLI /user response")?;

    Ok(Some(GithubCliUser {
        login: parsed.login,
        id: parsed.id,
        name: parsed.name,
        avatar_url: parsed.avatar_url,
        email: parsed.email,
    }))
}

#[cfg(test)]
fn list_github_accessible_repositories_with(
    runner: &impl GhCommandRunner,
) -> Result<Vec<GithubRepositorySummary>> {
    let status = get_github_cli_status_with(runner)?;
    list_github_accessible_repositories_with_status(runner, &status)
}

fn list_github_accessible_repositories_with_status(
    runner: &impl GhCommandRunner,
    status: &GithubCliStatus,
) -> Result<Vec<GithubRepositorySummary>> {
    if !github_cli_is_ready(status) {
        return Ok(Vec::new());
    }

    let output = match runner.run(["api", GITHUB_REPOS_ENDPOINT]) {
        Ok(output) => output,
        Err(GhCommandError::NotFound) => return Ok(Vec::new()),
        Err(GhCommandError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            let detail = command_error_detail(&stdout, &stderr, code);
            if looks_like_unauthenticated(&detail) {
                return Ok(Vec::new());
            }

            return Err(anyhow!("GitHub CLI repository lookup failed: {detail}"));
        }
        Err(GhCommandError::Other(message)) => {
            return Err(anyhow!("GitHub CLI repository lookup failed: {message}"));
        }
    };

    let parsed = serde_json::from_str::<Vec<GithubApiRepository>>(&output.stdout)
        .context("Failed to decode GitHub CLI /user/repos response")?;

    Ok(parsed
        .into_iter()
        .map(|repository| GithubRepositorySummary {
            id: repository.id,
            name: repository.name,
            full_name: repository.full_name,
            owner_login: repository.owner.login,
            private: repository.private,
            default_branch: repository.default_branch,
            html_url: repository.html_url,
            updated_at: repository.updated_at,
            pushed_at: repository.pushed_at,
        })
        .collect())
}

fn parse_gh_version(stdout: &str) -> String {
    stdout
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(2))
        .unwrap_or("unknown")
        .to_string()
}

fn command_error_detail(stdout: &str, stderr: &str, code: Option<i32>) -> String {
    let trimmed_stderr = stderr.trim();
    if !trimmed_stderr.is_empty() {
        return trimmed_stderr.to_string();
    }

    let trimmed_stdout = stdout.trim();
    if !trimmed_stdout.is_empty() {
        return trimmed_stdout.to_string();
    }

    match code {
        Some(code) => format!("gh exited with status {code}"),
        None => "gh exited unsuccessfully".to_string(),
    }
}

fn looks_like_unauthenticated(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("not logged into")
        || normalized.contains("authentication failed")
        || normalized.contains("gh auth login")
}

fn github_cli_is_ready(status: &GithubCliStatus) -> bool {
    matches!(status, GithubCliStatus::Ready { .. })
}

fn load_cached_system_github_cli_status() -> Result<GithubCliStatus> {
    load_cached_status(&SYSTEM_GH_STATUS_CACHE, GITHUB_CLI_STATUS_CACHE_TTL, || {
        get_github_cli_status_with(&SystemGhRunner)
    })
}

fn load_cached_status(
    cache: &Mutex<Option<CachedGithubCliStatus>>,
    ttl: Duration,
    loader: impl FnOnce() -> Result<GithubCliStatus>,
) -> Result<GithubCliStatus> {
    let mut cache_guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache_guard.as_ref() {
        if cached.cached_at.elapsed() <= ttl {
            return Ok(cached.status.clone());
        }
    }

    let status = loader()?;
    *cache_guard = Some(CachedGithubCliStatus {
        cached_at: Instant::now(),
        status: status.clone(),
    });
    Ok(status)
}

struct SystemGhRunner;

impl GhCommandRunner for SystemGhRunner {
    fn run<I, S>(&self, args: I) -> std::result::Result<GhCommandOutput, GhCommandError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new("gh");
        for arg in args {
            command.arg(arg.as_ref());
        }

        let output = command.output().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GhCommandError::NotFound
            } else {
                GhCommandError::Other(error.to_string())
            }
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if output.status.success() {
            return Ok(GhCommandOutput { stdout });
        }

        Err(GhCommandError::Failed {
            stdout,
            stderr,
            code: output.status.code(),
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct GhAuthStatusResponse {
    hosts: HashMap<String, Vec<GhHostStatusEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhHostStatusEntry {
    state: Option<String>,
    active: Option<bool>,
    host: Option<String>,
    login: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubApiUser {
    login: String,
    id: i64,
    name: Option<String>,
    avatar_url: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubApiRepository {
    id: i64,
    name: String,
    full_name: String,
    private: bool,
    default_branch: Option<String>,
    html_url: String,
    updated_at: Option<String>,
    pushed_at: Option<String>,
    owner: GithubApiRepositoryOwner,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubApiRepositoryOwner {
    login: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    #[derive(Clone)]
    enum MockRunnerResponse {
        Success {
            stdout: String,
            stderr: String,
        },
        NotFound,
        Failed {
            stdout: String,
            stderr: String,
            code: Option<i32>,
        },
        Other(String),
    }

    struct MockGhRunner {
        responses: RefCell<VecDeque<MockRunnerResponse>>,
    }

    impl MockGhRunner {
        fn new(responses: impl IntoIterator<Item = MockRunnerResponse>) -> Self {
            Self {
                responses: RefCell::new(responses.into_iter().collect()),
            }
        }
    }

    impl GhCommandRunner for MockGhRunner {
        fn run<I, S>(&self, _args: I) -> std::result::Result<GhCommandOutput, GhCommandError>
        where
            I: IntoIterator<Item = S>,
            S: AsRef<OsStr>,
        {
            match self
                .responses
                .borrow_mut()
                .pop_front()
                .expect("mock response should exist")
            {
                MockRunnerResponse::Success { stdout, stderr } => {
                    let _ = stderr;
                    Ok(GhCommandOutput { stdout })
                }
                MockRunnerResponse::NotFound => Err(GhCommandError::NotFound),
                MockRunnerResponse::Failed {
                    stdout,
                    stderr,
                    code,
                } => Err(GhCommandError::Failed {
                    stdout,
                    stderr,
                    code,
                }),
                MockRunnerResponse::Other(message) => Err(GhCommandError::Other(message)),
            }
        }
    }

    #[test]
    fn get_github_cli_status_parses_ready_state() {
        let runner = MockGhRunner::new([
            MockRunnerResponse::Success {
                stdout:
                    "gh version 2.88.1 (2026-03-12)\nhttps://github.com/cli/cli/releases/tag/v2.88.1\n"
                        .to_string(),
                stderr: String::new(),
            },
            MockRunnerResponse::Success {
                stdout: r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"dohooo"}]}}"#
                    .to_string(),
                stderr: String::new(),
            },
        ]);

        let status = get_github_cli_status_with(&runner).unwrap();

        assert_eq!(
            status,
            GithubCliStatus::Ready {
                host: "github.com".to_string(),
                login: "dohooo".to_string(),
                version: "2.88.1".to_string(),
                message: "GitHub CLI ready as dohooo.".to_string(),
            }
        );
    }

    #[test]
    fn get_github_cli_status_returns_unavailable_when_gh_is_missing() {
        let runner = MockGhRunner::new([MockRunnerResponse::NotFound]);

        let status = get_github_cli_status_with(&runner).unwrap();

        assert_eq!(
            status,
            GithubCliStatus::Unavailable {
                host: "github.com".to_string(),
                message: "GitHub CLI is not installed on this machine.".to_string(),
            }
        );
    }

    #[test]
    fn get_github_cli_status_returns_unauthenticated_when_gh_is_not_logged_in() {
        let runner = MockGhRunner::new([
            MockRunnerResponse::Success {
                stdout: "gh version 2.88.1 (2026-03-12)\n".to_string(),
                stderr: String::new(),
            },
            MockRunnerResponse::Failed {
                stdout: String::new(),
                stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login"
                    .to_string(),
                code: Some(1),
            },
        ]);

        let status = get_github_cli_status_with(&runner).unwrap();

        assert_eq!(
            status,
            GithubCliStatus::Unauthenticated {
                host: "github.com".to_string(),
                version: Some("2.88.1".to_string()),
                message: "Run `gh auth login` to connect GitHub CLI.".to_string(),
            }
        );
    }

    #[test]
    fn get_github_cli_user_parses_user_profile() {
        let runner = MockGhRunner::new([
            MockRunnerResponse::Success {
                stdout: "gh version 2.88.1 (2026-03-12)\n".to_string(),
                stderr: String::new(),
            },
            MockRunnerResponse::Success {
                stdout: r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"dohooo"}]}}"#
                    .to_string(),
                stderr: String::new(),
            },
            MockRunnerResponse::Success {
                stdout: r#"{"login":"dohooo","id":32405058,"name":"Caspian Dongho","avatar_url":"https://avatars.githubusercontent.com/u/32405058?v=4","email":"caspian.zhao@outlook.com"}"#
                    .to_string(),
                stderr: String::new(),
            },
        ]);

        let user = get_github_cli_user_with(&runner).unwrap();

        assert_eq!(
            user,
            Some(GithubCliUser {
                login: "dohooo".to_string(),
                id: 32405058,
                name: Some("Caspian Dongho".to_string()),
                avatar_url: Some(
                    "https://avatars.githubusercontent.com/u/32405058?v=4".to_string()
                ),
                email: Some("caspian.zhao@outlook.com".to_string()),
            })
        );
    }

    #[test]
    fn list_github_accessible_repositories_parses_repository_list() {
        let runner = MockGhRunner::new([
            MockRunnerResponse::Success {
                stdout: "gh version 2.88.1 (2026-03-12)\n".to_string(),
                stderr: String::new(),
            },
            MockRunnerResponse::Success {
                stdout: r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"dohooo"}]}}"#
                    .to_string(),
                stderr: String::new(),
            },
            MockRunnerResponse::Success {
                stdout: r#"[{"id":1199028956,"name":"helmor","full_name":"dohooo/helmor","private":true,"default_branch":"main","html_url":"https://github.com/dohooo/helmor","updated_at":"2026-04-04T08:15:07Z","pushed_at":"2026-04-04T08:15:03Z","owner":{"login":"dohooo"}}]"#
                    .to_string(),
                stderr: String::new(),
            },
        ]);

        let repositories = list_github_accessible_repositories_with(&runner).unwrap();

        assert_eq!(
            repositories,
            vec![GithubRepositorySummary {
                id: 1199028956,
                name: "helmor".to_string(),
                full_name: "dohooo/helmor".to_string(),
                owner_login: "dohooo".to_string(),
                private: true,
                default_branch: Some("main".to_string()),
                html_url: "https://github.com/dohooo/helmor".to_string(),
                updated_at: Some("2026-04-04T08:15:07Z".to_string()),
                pushed_at: Some("2026-04-04T08:15:03Z".to_string()),
            }]
        );
    }

    #[test]
    fn get_github_cli_user_returns_none_when_unauthenticated() {
        let runner = MockGhRunner::new([
            MockRunnerResponse::Success {
                stdout: "gh version 2.88.1 (2026-03-12)\n".to_string(),
                stderr: String::new(),
            },
            MockRunnerResponse::Failed {
                stdout: String::new(),
                stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login"
                    .to_string(),
                code: Some(1),
            },
        ]);

        let user = get_github_cli_user_with(&runner).unwrap();

        assert_eq!(user, None);
    }

    #[test]
    fn get_github_cli_status_surfaces_version_lookup_errors() {
        let runner =
            MockGhRunner::new([MockRunnerResponse::Other("permission denied".to_string())]);

        let status = get_github_cli_status_with(&runner).unwrap();

        assert_eq!(
            status,
            GithubCliStatus::Error {
                host: "github.com".to_string(),
                version: None,
                message: "Unable to read GitHub CLI version: permission denied".to_string(),
            }
        );
    }

    #[test]
    fn load_cached_status_reuses_fresh_cached_value() {
        let cache = Mutex::new(None);
        let calls = Cell::new(0);

        let first = load_cached_status(&cache, Duration::from_secs(60), || {
            calls.set(calls.get() + 1);
            Ok(GithubCliStatus::Unavailable {
                host: "github.com".to_string(),
                message: "missing".to_string(),
            })
        })
        .unwrap();

        let second = load_cached_status(&cache, Duration::from_secs(60), || {
            calls.set(calls.get() + 1);
            Ok(GithubCliStatus::Unavailable {
                host: "github.com".to_string(),
                message: "other".to_string(),
            })
        })
        .unwrap();

        assert_eq!(calls.get(), 1);
        assert_eq!(first, second);
    }
}
