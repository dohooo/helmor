//! Git remote URL parsing helpers for forge detection and provider APIs.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedRemote {
    pub(crate) host: String,
    pub(crate) namespace: String,
    pub(crate) repo: String,
    pub(crate) path: String,
}

pub(crate) fn parse_remote(remote: &str) -> Option<ParsedRemote> {
    let remote = remote.trim();
    if remote.is_empty() {
        return None;
    }

    if let Some((user_host, path)) = remote.split_once(':') {
        if !user_host.contains("://") && user_host.contains('@') {
            let host = user_host.rsplit_once('@')?.1;
            return parsed_remote_from_host_path(host, path);
        }
    }

    for prefix in ["https://", "http://", "git://", "ssh://"] {
        if let Some(rest) = remote.strip_prefix(prefix) {
            let rest = rest.strip_prefix("git@").unwrap_or(rest);
            let (host, path) = rest.split_once('/')?;
            return parsed_remote_from_host_path(host, path);
        }
    }

    None
}

fn parsed_remote_from_host_path(host: &str, path: &str) -> Option<ParsedRemote> {
    let host = host.trim().trim_end_matches('/');
    let raw_path = path.trim().trim_matches('/');
    let trimmed_path = raw_path.trim_end_matches(".git");
    let mut parts = trimmed_path.rsplitn(2, '/');
    let repo = parts.next()?.trim();
    let namespace = parts.next()?.trim();
    if host.is_empty() || namespace.is_empty() || repo.is_empty() {
        return None;
    }
    Some(ParsedRemote {
        host: host.to_ascii_lowercase(),
        namespace: namespace.to_string(),
        repo: repo.to_string(),
        path: raw_path.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_https_remote() {
        let parsed = parse_remote("https://github.com/octocat/hello-world.git").unwrap();
        assert_eq!(parsed.host, "github.com");
        assert_eq!(parsed.namespace, "octocat");
        assert_eq!(parsed.repo, "hello-world");
    }

    #[test]
    fn parses_gitlab_nested_namespace() {
        let parsed = parse_remote("git@gitlab.company.com:platform/tools/api.git").unwrap();
        assert_eq!(parsed.host, "gitlab.company.com");
        assert_eq!(parsed.namespace, "platform/tools");
        assert_eq!(parsed.repo, "api");
    }

    #[test]
    fn rejects_incomplete_remote() {
        assert!(parse_remote("https://github.com/").is_none());
        assert!(parse_remote("git@github.com:incomplete").is_none());
    }

    #[test]
    fn rejects_empty_or_whitespace_remote() {
        assert!(parse_remote("").is_none());
        assert!(parse_remote("   ").is_none());
    }

    #[test]
    fn rejects_unrecognized_scheme() {
        assert!(parse_remote("rsync://example.com/foo/bar.git").is_none());
        assert!(parse_remote("file:///local/repo").is_none());
    }

    #[test]
    fn host_is_normalized_to_lowercase() {
        let parsed = parse_remote("https://GitHub.COM/Octocat/Hello-World.git").unwrap();
        assert_eq!(parsed.host, "github.com");
        // Owner / repo casing is preserved — only the host is normalized.
        assert_eq!(parsed.namespace, "Octocat");
        assert_eq!(parsed.repo, "Hello-World");
    }

    #[test]
    fn parses_ssh_scheme_with_explicit_protocol() {
        let parsed = parse_remote("ssh://git@gitlab.com/group/sub/repo.git").unwrap();
        assert_eq!(parsed.host, "gitlab.com");
        assert_eq!(parsed.namespace, "group/sub");
        assert_eq!(parsed.repo, "repo");
    }

    #[test]
    fn raw_path_preserves_git_suffix() {
        let parsed = parse_remote("https://github.com/octocat/hello-world.git").unwrap();
        // `path` keeps the literal value the user typed (after trimming slashes).
        assert!(parsed.path.ends_with("hello-world.git"));
    }

    #[test]
    fn handles_trailing_slash_after_repo() {
        let parsed = parse_remote("https://github.com/octocat/hello-world/").unwrap();
        assert_eq!(parsed.namespace, "octocat");
        assert_eq!(parsed.repo, "hello-world");
    }

    #[test]
    fn ssh_form_with_no_path_is_rejected() {
        assert!(parse_remote("git@github.com:").is_none());
    }
}
