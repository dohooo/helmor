//! Minimal `~/.ssh/config` parser — just enough to surface host
//! aliases as suggestions in the SSH connect form. Doesn't try to
//! emulate ssh's full resolution logic (per-directive precedence,
//! ProxyJump chains) — those don't change the set of names a user
//! would type into the host field.
//!
//! Lines beginning with `Host <alias> [alias2 ...]` are scanned and
//! their aliases collected. Wildcard patterns (`*`, `?`, `!`) are
//! filtered out because they're config-side conventions, not literal
//! hosts the user would connect to. Everything else (HostName, User,
//! ProxyJump, ...) is ignored.
//!
//! ## `Include` resolution (phase 21c)
//!
//! `Include <path>` directives are followed, mirroring ssh's own
//! semantics:
//!
//! - Relative paths resolve against the *base directory* — `~/.ssh/`
//!   for user configs. Matches `ssh_config(5)`: "Files without
//!   absolute paths are assumed to be in ~/.ssh".
//! - Absolute paths are used verbatim.
//! - `~/...` is expanded against `$HOME`.
//! - Glob wildcards in paths are expanded (lexical order, per ssh).
//! - Unreadable / missing includes are skipped silently — ssh
//!   tolerates them and our suggestion list shouldn't fail loudly
//!   because the user's config references a non-existent file.
//! - Loops are detected via a visited-paths set keyed by canonical
//!   path; revisits are no-ops.
//! - Recursion is capped at [`MAX_INCLUDE_DEPTH`] (matches OpenSSH's
//!   own MAX_INCLUDES) so a pathological chain can't OOM.
//!
//! ## Lookup order
//!
//! Production callers should go through [`list_user_ssh_hosts`] which
//! reads `$HOME/.ssh/config` and falls back to an empty list on
//! missing-file / read-error. Tests can drive [`parse_hosts`]
//! directly with a literal string (no Include support) or
//! [`parse_hosts_from_path`] with a real on-disk file.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

/// Hard cap on how deep we'll follow `Include` directives. Mirrors
/// OpenSSH's MAX_INCLUDES. A user with a deeper chain than this
/// almost certainly has a circular include and we'd rather drop the
/// extra layers than spin forever.
const MAX_INCLUDE_DEPTH: u8 = 16;

/// Hosts the user has named in `~/.ssh/config`. Sorted + deduped so
/// the UI gets a stable suggestion order; non-existent / unreadable
/// config → empty list (treated as "no suggestions", not an error).
pub fn list_user_ssh_hosts() -> Vec<String> {
    let Some(path) = user_ssh_config_path() else {
        return Vec::new();
    };
    parse_hosts_from_path(&path)
}

/// Parse the body of an ssh_config file into the set of named host
/// aliases. Pure function over a string — does **not** follow
/// `Include` directives (no file IO). Tests + ad-hoc callers use
/// this; production paths go through [`parse_hosts_from_path`].
pub fn parse_hosts(content: &str) -> Vec<String> {
    let mut hosts: BTreeSet<String> = BTreeSet::new();
    collect_hosts_from_body(content, &mut hosts);
    hosts.into_iter().collect()
}

/// Parse an ssh_config file at `path`, following `Include` directives
/// against the same base directory ssh uses (`~/.ssh/` for user
/// configs). Missing / unreadable files silently contribute zero
/// aliases.
pub fn parse_hosts_from_path(path: &Path) -> Vec<String> {
    let mut hosts: BTreeSet<String> = BTreeSet::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let base_dir = ssh_base_dir_from_config_path(path);
    walk_config_file(path, &base_dir, &mut hosts, &mut visited, 0);
    hosts.into_iter().collect()
}

/// Body-only collector. Skips `Include` lines because the caller is
/// the no-IO path; production walks them via [`walk_config_file`].
fn collect_hosts_from_body(content: &str, hosts: &mut BTreeSet<String>) {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = strip_host_directive(trimmed) {
            push_aliases(rest, hosts);
        }
    }
}

/// Walk one config file, recursing into `Include` directives in
/// lexical order. Logs + skips on any error so a broken file in the
/// chain doesn't take the whole alias list down.
fn walk_config_file(
    path: &Path,
    base_dir: &Path,
    hosts: &mut BTreeSet<String>,
    visited: &mut HashSet<PathBuf>,
    depth: u8,
) {
    if depth >= MAX_INCLUDE_DEPTH {
        tracing::debug!(
            path = %path.display(),
            depth,
            "ssh_config: include depth cap hit; skipping further recursion"
        );
        return;
    }
    // Canonicalise so symlink loops + path-with-./.. variants resolve
    // to the same key. Missing files canonicalise to Err — fall back
    // to the raw path so we don't silently treat /foo/x and /foo/./x
    // as distinct when the user has been clever.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        // Already walked this file; circular include.
        tracing::debug!(
            path = %path.display(),
            "ssh_config: skipping already-visited file (circular include?)"
        );
        return;
    }

    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return,
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = strip_host_directive(trimmed) {
            push_aliases(rest, hosts);
            continue;
        }
        if let Some(rest) = strip_keyword(trimmed, "Include") {
            // ssh permits multiple whitespace-separated paths per
            // `Include` line.
            for token in rest.split_whitespace() {
                expand_include(token, base_dir, hosts, visited, depth + 1);
            }
        }
    }
}

/// Resolve one `Include` token (possibly containing `~/` and globs)
/// against `base_dir`, then recurse into each matching file.
fn expand_include(
    token: &str,
    base_dir: &Path,
    hosts: &mut BTreeSet<String>,
    visited: &mut HashSet<PathBuf>,
    depth: u8,
) {
    let expanded = expand_tilde(token);
    let candidate = if Path::new(&expanded).is_absolute() {
        PathBuf::from(expanded)
    } else {
        base_dir.join(expanded)
    };
    // Glob-expand. `glob` itself returns paths in lexical order per
    // the crate docs — matches ssh's "wildcards expanded and processed
    // in lexical order".
    let pattern = candidate.to_string_lossy();
    let Ok(matches) = glob::glob(&pattern) else {
        // Malformed pattern (e.g. unbalanced brackets). Treat as
        // no-match — same effect as ssh's silent skip.
        tracing::debug!(
            pattern = %pattern,
            "ssh_config: malformed include glob; skipping"
        );
        return;
    };
    for entry in matches.flatten() {
        // Skip directories: ssh `Include` doesn't recurse into
        // directories, only matches files.
        if entry.is_dir() {
            continue;
        }
        walk_config_file(&entry, base_dir, hosts, visited, depth);
    }
}

/// `~/...` expansion. Returns the input verbatim if `$HOME` isn't
/// resolvable; ssh would error in that case, but we'd rather pass the
/// literal path through and let the file-read step bail naturally.
fn expand_tilde(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = std::env::var("HOME").ok().filter(|s| !s.is_empty()) {
            return format!("{home}/{rest}");
        }
    }
    raw.to_string()
}

fn push_aliases(rest: &str, hosts: &mut BTreeSet<String>) {
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

/// Pick the base directory ssh uses for relative `Include` paths.
/// For a config under `~/.ssh/config` it's `~/.ssh/`; for any other
/// path we use that path's parent directory so tests can drive the
/// parser with tempdir fixtures without spoofing `$HOME`.
fn ssh_base_dir_from_config_path(path: &Path) -> PathBuf {
    path.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Match `Host` or `host` followed by whitespace; return the trailing
/// alias list. Returns `None` for any other directive.
fn strip_host_directive(line: &str) -> Option<&str> {
    strip_keyword(line, "Host")
}

/// Generic "match an ssh keyword case-insensitively, return the
/// trailing argument list." Accepts both `Keyword arg` and
/// `Keyword=arg` (ssh permits both). Returns `None` for any other
/// directive.
fn strip_keyword<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let (head, tail) = line.split_at(line.find(|c: char| c.is_whitespace() || c == '=')?);
    if !head.eq_ignore_ascii_case(keyword) {
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
    use std::fs;
    use tempfile::TempDir;

    // ── existing body-only tests (parse_hosts) ───────────────────

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

    #[test]
    fn body_only_parse_hosts_silently_ignores_include_lines() {
        // `parse_hosts(&str)` is the no-IO path; Include directives
        // shouldn't surface aliases by name (nor crash). Production
        // callers route through `parse_hosts_from_path` for include
        // resolution.
        let cfg = "\
Include conf.d/*
Host local-only
";
        assert_eq!(parse_hosts(cfg), vec!["local-only"]);
    }

    // ── Include resolution (parse_hosts_from_path) ────────────────

    /// Build a self-contained ssh-config fixture under a tempdir.
    /// `files` is a list of `(relative_path, contents)` pairs; the
    /// first entry is the root config. Returns `(TempDir, root_path)`
    /// where `root_path` is the absolute path to the first file.
    fn fixture(files: &[(&str, &str)]) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let mut root_path = None;
        for (relative, contents) in files {
            let full = dir.path().join(relative);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&full, contents).unwrap();
            if root_path.is_none() {
                root_path = Some(full);
            }
        }
        (dir, root_path.expect("at least one fixture file"))
    }

    #[test]
    fn include_with_relative_path_resolves_against_base_dir() {
        // `Include extra.conf` should resolve to `<base>/extra.conf`,
        // not be a literal path.
        let (_dir, root) = fixture(&[
            (
                "config",
                "\
Include extra.conf
Host local
",
            ),
            ("extra.conf", "Host included\n"),
        ]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["included", "local"]);
    }

    #[test]
    fn include_with_absolute_path_is_used_verbatim() {
        let extras = TempDir::new().unwrap();
        let extras_file = extras.path().join("extras.conf");
        fs::write(&extras_file, "Host absolute-host\n").unwrap();

        let (_dir, root) = fixture(&[(
            "config",
            &format!(
                "\
Include {abs}
Host base-host
",
                abs = extras_file.display()
            ),
        )]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["absolute-host", "base-host"]);
    }

    #[test]
    fn include_with_glob_picks_up_every_matching_file_in_lexical_order() {
        let (_dir, root) = fixture(&[
            (
                "config",
                "\
Include conf.d/*.conf
Host base
",
            ),
            ("conf.d/work.conf", "Host work-host\n"),
            ("conf.d/staging.conf", "Host stage-host\n"),
            // Files that don't match the glob are ignored.
            ("conf.d/notes.txt", "Host should-not-appear\n"),
        ]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["base", "stage-host", "work-host"]);
    }

    #[test]
    fn include_with_glob_skips_directories_matching_the_pattern() {
        // `conf.d/*` would otherwise match a subdirectory; ssh's
        // Include only loads files, not directories.
        let (_dir, root) = fixture(&[
            (
                "config",
                "\
Include conf.d/*
Host base
",
            ),
            ("conf.d/leaf.conf", "Host leaf\n"),
            ("conf.d/subdir/nested.conf", "Host nested\n"),
        ]);
        let hosts = parse_hosts_from_path(&root);
        // `leaf` is included; `nested` isn't because it's reachable
        // only via the subdirectory.
        assert!(hosts.contains(&"leaf".to_string()), "{hosts:?}");
        assert!(hosts.contains(&"base".to_string()), "{hosts:?}");
        assert!(!hosts.contains(&"nested".to_string()), "{hosts:?}");
    }

    #[test]
    fn include_supports_chained_inclusion_across_three_files() {
        // root → conf.d/work.conf → conf.d/staging.conf
        let (_dir, root) = fixture(&[
            (
                "config",
                "\
Include conf.d/work.conf
Host root
",
            ),
            (
                "conf.d/work.conf",
                "\
Include conf.d/staging.conf
Host work
",
            ),
            ("conf.d/staging.conf", "Host stage\n"),
        ]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["root", "stage", "work"]);
    }

    #[test]
    fn include_missing_file_is_silently_skipped() {
        // `Include not-here.conf` referencing a non-existent file
        // must not error; the rest of the config still contributes
        // aliases.
        let (_dir, root) = fixture(&[(
            "config",
            "\
Include not-here.conf
Host survivor
",
        )]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["survivor"]);
    }

    #[test]
    fn include_with_circular_reference_terminates() {
        // a.conf includes b.conf; b.conf includes a.conf. Loop detection
        // breaks the cycle on the second visit; both files'
        // aliases still appear exactly once.
        let (_dir, root) = fixture(&[
            (
                "a.conf",
                "\
Include b.conf
Host alpha
",
            ),
            (
                "b.conf",
                "\
Include a.conf
Host beta
",
            ),
        ]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["alpha", "beta"]);
    }

    #[test]
    fn include_with_self_reference_terminates() {
        let (_dir, root) = fixture(&[(
            "config",
            "\
Include config
Host only
",
        )]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["only"]);
    }

    #[test]
    fn include_respects_the_recursion_depth_cap() {
        // Build MAX_INCLUDE_DEPTH+5 files chained head-to-tail; the
        // walker must stop before OOMing and surface what it can.
        // The deepest file's alias must NOT appear because depth ran
        // out before we got there.
        let dir = TempDir::new().unwrap();
        let total = (MAX_INCLUDE_DEPTH as usize) + 5;
        for i in 0..total {
            let path = dir.path().join(format!("c{i}.conf"));
            let body = if i + 1 < total {
                format!("Include c{}.conf\nHost h{i}\n", i + 1)
            } else {
                format!("Host h{i}\n")
            };
            fs::write(&path, body).unwrap();
        }
        let root = dir.path().join("c0.conf");
        let hosts = parse_hosts_from_path(&root);
        // The first MAX_INCLUDE_DEPTH files contribute; the tail
        // does not. We don't assert the exact cutoff index because
        // off-by-one in the depth counter shouldn't fail the test —
        // we only care that the cap holds.
        assert!(
            hosts.contains(&"h0".to_string()),
            "shallowest entry should always appear: {hosts:?}"
        );
        let deepest = format!("h{}", total - 1);
        assert!(
            !hosts.contains(&deepest),
            "deepest entry must be cut off by the depth cap: {hosts:?}"
        );
    }

    #[test]
    fn include_supports_multiple_paths_on_one_directive_line() {
        // `Include a.conf b.conf` is legal ssh syntax — both should
        // resolve.
        let (_dir, root) = fixture(&[
            (
                "config",
                "\
Include a.conf b.conf
Host root
",
            ),
            ("a.conf", "Host alpha\n"),
            ("b.conf", "Host beta\n"),
        ]);
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["alpha", "beta", "root"]);
    }

    #[test]
    fn include_with_unreadable_path_does_not_panic() {
        // A path that points at a directory rather than a file: read
        // fails, walker recovers silently.
        let dir = TempDir::new().unwrap();
        let dir_as_include = dir.path().join("conf.d");
        fs::create_dir_all(&dir_as_include).unwrap();
        let root = dir.path().join("config");
        fs::write(
            &root,
            "\
Include conf.d
Host base
",
        )
        .unwrap();
        let hosts = parse_hosts_from_path(&root);
        assert_eq!(hosts, vec!["base"]);
    }

    #[test]
    fn parse_hosts_from_path_returns_empty_for_missing_file() {
        // The user-facing entry point `list_user_ssh_hosts` already
        // null-checks the file, but `parse_hosts_from_path` is public
        // and should mirror that contract.
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("never.conf");
        assert!(parse_hosts_from_path(&missing).is_empty());
    }
}
