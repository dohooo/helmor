//! Minimal `~/.ssh/config` parser — just enough to surface host
//! aliases as suggestions in the SSH connect form. Doesn't try to
//! emulate ssh's full resolution logic (Include directives, Match
//! blocks, per-directive precedence) — those don't change the set
//! of names a user would type into the host field.
//!
//! Lines beginning with `Host <alias> [alias2 ...]` are scanned and
//! their aliases collected. Wildcard patterns (`*`, `?`, `!`) are
//! filtered out because they're config-side conventions, not literal
//! hosts the user would connect to. Everything else (HostName, User,
//! ProxyJump, ...) is ignored.
//!
//! ## Lookup order
//!
//! Production callers should go through [`list_user_ssh_hosts`] which
//! reads `$HOME/.ssh/config` and falls back to an empty list on
//! missing-file / read-error. Tests can drive [`parse_hosts`]
//! directly with a literal string.

use std::collections::BTreeSet;
use std::path::PathBuf;

/// Hosts the user has named in `~/.ssh/config`. Sorted + deduped so
/// the UI gets a stable suggestion order; non-existent / unreadable
/// config → empty list (treated as "no suggestions", not an error).
pub fn list_user_ssh_hosts() -> Vec<String> {
    let Some(path) = user_ssh_config_path() else {
        return Vec::new();
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    parse_hosts(&raw)
}

/// Parse the body of an ssh_config file into the set of named host
/// aliases. Pure function over a string so unit tests can feed any
/// shape without setting up a real `~/.ssh/config`.
pub fn parse_hosts(content: &str) -> Vec<String> {
    let mut hosts: BTreeSet<String> = BTreeSet::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // SSH keywords are case-insensitive. Match the leading
        // `Host` directive (with at least one whitespace before the
        // alias list) regardless of case.
        let Some(rest) = strip_host_directive(trimmed) else {
            continue;
        };
        for alias in rest.split_whitespace() {
            // Filter ssh's pattern operators — they're matchers, not
            // dialable names. `!host` is the negation form, also not
            // a literal host.
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                continue;
            }
            hosts.insert(alias.to_string());
        }
    }
    hosts.into_iter().collect()
}

/// Match `Host` or `host` followed by whitespace; return the trailing
/// alias list. Returns `None` for any other directive.
fn strip_host_directive(line: &str) -> Option<&str> {
    // Find the first non-keyword char. Cheaper than building a regex.
    // We accept either `Host alias` or `Host=alias` even though the
    // `=` form is rare in practice — ssh permits both.
    let (head, tail) = line.split_at(line.find(|c: char| c.is_whitespace() || c == '=')?);
    if !head.eq_ignore_ascii_case("Host") {
        return None;
    }
    Some(
        tail.trim_start_matches(|c: char| c.is_whitespace() || c == '=')
            .trim(),
    )
}

/// `$HOME/.ssh/config`. Returns `None` if `$HOME` doesn't resolve —
/// the function is best-effort so the suggestion list can degrade to
/// empty without bubbling an error.
fn user_ssh_config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().filter(|s| !s.is_empty())?;
    Some(PathBuf::from(home).join(".ssh").join("config"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_aliases() {
        let cfg = "\
Host dev.box
    HostName 10.0.2.31
    User david

Host my-laptop
    HostName 192.168.1.5
";
        assert_eq!(parse_hosts(cfg), vec!["dev.box", "my-laptop"]);
    }

    #[test]
    fn collects_multiple_aliases_on_a_single_host_line() {
        let cfg = "Host alpha beta gamma\n    HostName irrelevant\n";
        assert_eq!(parse_hosts(cfg), vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn drops_wildcard_patterns() {
        let cfg = "\
Host work-*.internal
    User dwork

Host real-host
    HostName 10.0.0.1

Host ?-name
    User x

Host !blocked
    User y
";
        assert_eq!(parse_hosts(cfg), vec!["real-host"]);
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let cfg = "\
# Personal hosts
Host home

# Work
   # indented comment

Host work
";
        assert_eq!(parse_hosts(cfg), vec!["home", "work"]);
    }

    #[test]
    fn deduplicates_aliases_repeated_across_blocks() {
        let cfg = "\
Host dev.box
    User a
Host dev.box
    User b
";
        assert_eq!(parse_hosts(cfg), vec!["dev.box"]);
    }

    #[test]
    fn is_case_insensitive_on_the_host_keyword() {
        let cfg = "host dev.box\nHOST another\nhOsT third\n";
        assert_eq!(parse_hosts(cfg), vec!["another", "dev.box", "third"]);
    }

    #[test]
    fn accepts_equals_form_of_host_directive() {
        // Rare in practice but legal — ssh's config parser allows it.
        let cfg = "Host=dev.box\nHost = my-laptop\n";
        assert_eq!(parse_hosts(cfg), vec!["dev.box", "my-laptop"]);
    }

    #[test]
    fn does_not_match_host_substring_in_other_directives() {
        // `HostName 10.0.0.1` must not surface "10.0.0.1" as an alias —
        // we only want the `Host` directive proper.
        let cfg = "Host dev\n    HostName 10.0.0.1\n";
        assert_eq!(parse_hosts(cfg), vec!["dev"]);
    }

    #[test]
    fn returns_empty_for_an_empty_string() {
        assert!(parse_hosts("").is_empty());
    }
}
