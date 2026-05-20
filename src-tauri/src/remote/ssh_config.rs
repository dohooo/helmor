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
//! ## `Match` blocks (phase 21d)
//!
//! A subset of `Match` predicates is honoured so aliases gated by
//! conditions actually surface (or get correctly excluded) in the
//! suggestion list:
//!
//! - `Match all` → always active.
//! - `Match user <pattern>` → active iff `$USER` matches the pattern.
//!   Supports glob wildcards (`*`, `?`), comma-separated alternatives,
//!   and `!`-prefixed negation entries (matches ssh's pattern-list
//!   semantics).
//! - `Match host <pattern>` → always treated as active for alias
//!   collection. We don't know which host the user will eventually
//!   connect to, so any potentially-applicable alias belongs in the
//!   suggestion list.
//! - Anything else (`Match exec`, `Match originalhost`, `Match
//!   canonical`, etc.) — treated as inactive (block dropped) with a
//!   debug log. Operators relying on exec-based gating should reach
//!   for the literal Host form anyway; the spike intentionally doesn't
//!   shell out from a suggestion-list refresh.
//!
//! A `Match` directive ends the previous Host or Match block. Host
//! directives inside an inactive Match block are dropped wholesale —
//! their aliases never enter the suggestion set.
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

use serde::{Deserialize, Serialize};

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
    let user = current_user();
    parse_hosts_from_path_with_user(path, user.as_deref())
}

/// Variant of [`parse_hosts_from_path`] that takes the user name
/// explicitly. Lets tests drive `Match user` evaluation without
/// poking at the process-wide `$USER` env var (which would race with
/// other test threads). `None` mirrors a missing `$USER`: `Match
/// user` blocks always fail to match, so any alias gated only by
/// the user predicate stays excluded.
pub fn parse_hosts_from_path_with_user(path: &Path, user: Option<&str>) -> Vec<String> {
    let mut hosts: BTreeSet<String> = BTreeSet::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let base_dir = ssh_base_dir_from_config_path(path);
    walk_config_file(path, &base_dir, user, &mut hosts, &mut visited, 0);
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
///
/// `user` is the effective `$USER` for `Match user` evaluation;
/// `None` means "no user available" (`Match user` blocks always
/// fail).
fn walk_config_file(
    path: &Path,
    base_dir: &Path,
    user: Option<&str>,
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
    // Match-block gate: starts true (top of file = no block yet, so
    // every `Host` directive contributes by default). A `Match`
    // directive resets the flag based on its guards; the flag stays
    // in effect until the next `Match` (or until a recursive Include
    // returns — Match blocks don't cross file boundaries).
    let mut block_active = true;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = strip_keyword(trimmed, "Match") {
            block_active = match evaluate_match(rest, user) {
                MatchOutcome::Active => true,
                MatchOutcome::Inactive | MatchOutcome::Unsupported => false,
            };
            continue;
        }
        if let Some(rest) = strip_host_directive(trimmed) {
            // `Host` also closes any prior Match block — the next
            // line resets the gate to active so out-of-block Host
            // directives keep working.
            if block_active {
                push_aliases(rest, hosts);
            }
            block_active = true;
            continue;
        }
        if let Some(rest) = strip_keyword(trimmed, "Include") {
            // ssh permits multiple whitespace-separated paths per
            // `Include` line. Includes processed inside an inactive
            // block are still walked (ssh's semantics are that the
            // included file is parsed fresh with its own gate state);
            // we mirror that.
            for token in rest.split_whitespace() {
                expand_include(token, base_dir, user, hosts, visited, depth + 1);
            }
        }
    }
}

/// Resolve one `Include` token (possibly containing `~/` and globs)
/// against `base_dir`, then recurse into each matching file.
fn expand_include(
    token: &str,
    base_dir: &Path,
    user: Option<&str>,
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
        walk_config_file(&entry, base_dir, user, hosts, visited, depth);
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

// ── Match block evaluation (phase 21d) ──────────────────────────────

/// Result of evaluating a `Match` directive's guards against the
/// current process context. Conflates "predicate fired falsy" and
/// "predicate isn't supported by us" into a single inactive bucket
/// because both cases drop the block — the distinction only matters
/// for the debug log inside [`evaluate_match`].
enum MatchOutcome {
    /// Every supported guard passed (or `Match all`). Host directives
    /// in the block contribute to the suggestion list.
    Active,
    /// One or more guards explicitly failed (e.g. `Match user me`
    /// when `$USER != me`). The block is dropped.
    Inactive,
    /// At least one guard used a predicate we don't implement
    /// (`exec`, `originalhost`, `canonical`, `tagged`, …). Treated
    /// as inactive so the block doesn't accidentally contribute
    /// aliases that ssh itself wouldn't activate.
    Unsupported,
}

/// Walk the argument list after `Match` and decide whether the block
/// should be active. Supported predicates: `all`, `user <pattern>`,
/// `host <pattern>`. Anything else flips the result to `Unsupported`
/// and the block is dropped with a debug log.
///
/// `user host` is collected for completeness but always treated as
/// satisfied — the suggestion list runs before any host is picked,
/// so we want every potentially-applicable alias visible. ssh proper
/// would re-evaluate at connect time anyway.
fn evaluate_match(rest: &str, user: Option<&str>) -> MatchOutcome {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    if tokens.is_empty() {
        return MatchOutcome::Unsupported;
    }

    // `Match all` short-circuits everything — and it's the only
    // single-token form ssh accepts.
    if tokens.len() == 1 && tokens[0].eq_ignore_ascii_case("all") {
        return MatchOutcome::Active;
    }

    let mut all_passed = true;
    let mut i = 0;
    while i < tokens.len() {
        let key = tokens[i];
        let Some(value) = tokens.get(i + 1) else {
            tracing::debug!(
                directive = %rest,
                "ssh_config: Match predicate `{key}` missing a value; skipping block"
            );
            return MatchOutcome::Unsupported;
        };
        match key.to_ascii_lowercase().as_str() {
            "user" => {
                if !match_user(value, user) {
                    all_passed = false;
                }
            }
            "host" => {
                // Always satisfied. We don't know the destination
                // host yet at suggestion-list time, so any alias
                // gated on `Match host` should remain visible.
            }
            other => {
                tracing::debug!(
                    directive = %rest,
                    predicate = other,
                    "ssh_config: Match predicate not supported; treating block as inactive"
                );
                return MatchOutcome::Unsupported;
            }
        }
        i += 2;
    }
    if all_passed {
        MatchOutcome::Active
    } else {
        MatchOutcome::Inactive
    }
}

/// True iff `current` matches any non-negated entry in `pattern_list`
/// and no negated entry matches first. Mirrors ssh's pattern-list
/// semantics: comma-separated alternatives, `!`-prefixed entries are
/// exclusions, glob wildcards (`*`, `?`) supported.
///
/// `None` for `current` (no `$USER`) → never matches.
fn match_user(pattern_list: &str, current: Option<&str>) -> bool {
    let Some(user) = current else {
        return false;
    };
    let mut matched = false;
    for raw in pattern_list.split(',') {
        let pat = raw.trim();
        if pat.is_empty() {
            continue;
        }
        if let Some(neg) = pat.strip_prefix('!') {
            // ssh's rule: a matching negation immediately rejects the
            // whole list. Short-circuit accordingly.
            if matches_pattern(neg, user) {
                return false;
            }
        } else if matches_pattern(pat, user) {
            matched = true;
        }
    }
    matched
}

/// Minimal glob-style matcher for `*` and `?`. ssh supports more
/// (character classes, etc.) but `Match user`'s common usage is
/// literal names + the occasional `*` wildcard, so we keep the
/// matcher tiny rather than dragging in a full glob engine for
/// per-line patterns.
fn matches_pattern(pattern: &str, value: &str) -> bool {
    // Recursive walk; short patterns make this fast in practice.
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    matches_pattern_impl(p, v)
}

fn matches_pattern_impl(p: &[u8], v: &[u8]) -> bool {
    let mut pi = 0;
    let mut vi = 0;
    // Backtrack points so `*` can grow as needed.
    let mut star_pi: Option<usize> = None;
    let mut star_vi: usize = 0;
    while vi < v.len() {
        if pi < p.len() && (p[pi] == v[vi] || p[pi] == b'?') {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star_pi = Some(pi);
            star_vi = vi;
            pi += 1;
        } else if let Some(spi) = star_pi {
            pi = spi + 1;
            star_vi += 1;
            vi = star_vi;
        } else {
            return false;
        }
    }
    // Consume trailing `*`s in the pattern.
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

/// Best-effort current-user lookup. Falls back through `$USER` →
/// `$LOGNAME` so it works in environments where one is set but not
/// the other (containers often only have `LOGNAME`). Returns `None`
/// rather than guessing when neither is available — `Match user`
/// blocks evaluate as inactive in that case, which is the
/// conservative choice (don't surface aliases gated on a user we
/// can't confirm).
fn current_user() -> Option<String> {
    std::env::var("USER")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("LOGNAME").ok().filter(|s| !s.is_empty()))
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

// ── Track B2: per-host detail extraction ────────────────────────────
//
// `parse_hosts*` returns just alias names — enough for the wizard's
// type-ahead but not enough to surface "this alias actually connects
// to bastion → dev.box as user dwork via ~/.ssh/work_rsa". The
// per-host detail surface captures the four attributes operators most
// often want to see in the wizard before clicking Connect:
//
//   - HostName     — the real DNS name (different from the alias)
//   - User         — the SSH login
//   - IdentityFile — one or more keys (ssh permits multiple per host)
//   - ProxyJump    — the multi-hop chain
//
// Anything else (Port, PreferredAuthentications, …) is intentionally
// left out — the goal isn't to re-implement ssh, only to surface the
// fields a typo / wrong-bastion misconfig would manifest in.

/// One Host block flattened to the attributes the wizard surfaces.
/// Multiple aliases on the same `Host` line each get their own entry
/// (their attribute body is shared verbatim, mirroring ssh's
/// semantics).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDetail {
    /// The alias as it appeared after `Host` (or one of the aliases
    /// when several were on the same line).
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    /// Multiple `IdentityFile` lines per host are legal in ssh; we
    /// preserve the order they appeared in.
    pub identity_files: Vec<String>,
    pub proxy_jump: Option<String>,
}

/// Production entry point: walk `$HOME/.ssh/config` (with Include
/// resolution + Match gating) and return per-host details sorted by
/// alias. Empty list for missing config / `$HOME`.
pub fn list_user_ssh_host_details() -> Vec<HostDetail> {
    let Some(path) = user_ssh_config_path() else {
        return Vec::new();
    };
    let user = current_user();
    let mut details: Vec<HostDetail> = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let base_dir = ssh_base_dir_from_config_path(&path);
    walk_host_details(
        &path,
        &base_dir,
        user.as_deref(),
        &mut details,
        &mut visited,
        0,
    );
    details.sort_by(|a, b| a.alias.cmp(&b.alias));
    details
}

/// Body-only parser. Mirrors [`parse_hosts`] but emits a per-Host
/// detail struct. No Include resolution (no IO); tests + ad-hoc
/// callers use this with literal strings.
pub fn parse_host_details(content: &str) -> Vec<HostDetail> {
    let mut details: Vec<HostDetail> = Vec::new();
    collect_host_details_from_body(content, true, &mut details);
    // Sorted by alias so the surface is stable regardless of source
    // order — matches what `parse_hosts` does for plain names.
    details.sort_by(|a, b| a.alias.cmp(&b.alias));
    details
}

/// Single-file variant — used by the body-only parser AND by the
/// include-walking variant (which calls it per file with the
/// matching base directory). The `block_starts_active` flag mirrors
/// ssh's "files are evaluated fresh" rule: a Match in file A doesn't
/// leak into included file B.
fn collect_host_details_from_body(
    content: &str,
    _block_starts_active: bool,
    details: &mut Vec<HostDetail>,
) {
    let user = current_user();
    let mut current: Option<HostBlockAccumulator> = None;
    let mut block_active = true;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = strip_keyword(trimmed, "Match") {
            // Flush any in-progress host before swapping gates.
            if let Some(acc) = current.take() {
                if block_active {
                    acc.finalise_into(details);
                }
            }
            block_active = match evaluate_match(rest, user.as_deref()) {
                MatchOutcome::Active => true,
                MatchOutcome::Inactive | MatchOutcome::Unsupported => false,
            };
            continue;
        }
        if let Some(rest) = strip_host_directive(trimmed) {
            if let Some(acc) = current.take() {
                if block_active {
                    acc.finalise_into(details);
                }
            }
            block_active = true;
            let aliases: Vec<String> = rest
                .split_whitespace()
                .filter(|a| !a.contains('*') && !a.contains('?') && !a.starts_with('!'))
                .map(|a| a.to_string())
                .collect();
            if aliases.is_empty() {
                continue;
            }
            current = Some(HostBlockAccumulator::new(aliases));
            continue;
        }
        // Attribute lines apply to the in-progress block (if any).
        if let Some(acc) = current.as_mut() {
            apply_attribute(acc, trimmed);
        }
    }
    if let Some(acc) = current.take() {
        if block_active {
            acc.finalise_into(details);
        }
    }
}

/// Include-walking variant. Mirrors [`walk_config_file`] but emits
/// per-Host details. Includes processed inside an inactive Match
/// block are still walked (each file evaluates its own Match gate
/// fresh) — same semantics as the alias walker.
fn walk_host_details(
    path: &Path,
    base_dir: &Path,
    user: Option<&str>,
    details: &mut Vec<HostDetail>,
    visited: &mut HashSet<PathBuf>,
    depth: u8,
) {
    if depth >= MAX_INCLUDE_DEPTH {
        return;
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        return;
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return,
    };
    // We can't just call collect_host_details_from_body because it
    // doesn't know how to recurse into Include directives. Inline the
    // walker here.
    let mut current: Option<HostBlockAccumulator> = None;
    let mut block_active = true;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = strip_keyword(trimmed, "Match") {
            if let Some(acc) = current.take() {
                if block_active {
                    acc.finalise_into(details);
                }
            }
            block_active = match evaluate_match(rest, user) {
                MatchOutcome::Active => true,
                MatchOutcome::Inactive | MatchOutcome::Unsupported => false,
            };
            continue;
        }
        if let Some(rest) = strip_host_directive(trimmed) {
            if let Some(acc) = current.take() {
                if block_active {
                    acc.finalise_into(details);
                }
            }
            block_active = true;
            let aliases: Vec<String> = rest
                .split_whitespace()
                .filter(|a| !a.contains('*') && !a.contains('?') && !a.starts_with('!'))
                .map(|a| a.to_string())
                .collect();
            if aliases.is_empty() {
                continue;
            }
            current = Some(HostBlockAccumulator::new(aliases));
            continue;
        }
        if let Some(rest) = strip_keyword(trimmed, "Include") {
            // Flush in-progress host before recursing — its body has
            // ended even if the directive's tail is shared.
            if let Some(acc) = current.take() {
                if block_active {
                    acc.finalise_into(details);
                }
            }
            for token in rest.split_whitespace() {
                expand_include_for_details(token, base_dir, user, details, visited, depth + 1);
            }
            // Resetting block_active after Include matches the
            // semantics of the alias walker.
            block_active = true;
            continue;
        }
        if let Some(acc) = current.as_mut() {
            apply_attribute(acc, trimmed);
        }
    }
    if let Some(acc) = current.take() {
        if block_active {
            acc.finalise_into(details);
        }
    }
}

fn expand_include_for_details(
    token: &str,
    base_dir: &Path,
    user: Option<&str>,
    details: &mut Vec<HostDetail>,
    visited: &mut HashSet<PathBuf>,
    depth: u8,
) {
    let expanded = expand_tilde(token);
    let candidate = if Path::new(&expanded).is_absolute() {
        PathBuf::from(expanded)
    } else {
        base_dir.join(expanded)
    };
    let pattern = candidate.to_string_lossy();
    let Ok(matches) = glob::glob(&pattern) else {
        return;
    };
    for entry in matches.flatten() {
        if entry.is_dir() {
            continue;
        }
        walk_host_details(&entry, base_dir, user, details, visited, depth);
    }
}

/// Mutable accumulator: collects attributes for one Host block,
/// then fans out into N `HostDetail` entries on finalise (one per
/// alias on the `Host` line).
struct HostBlockAccumulator {
    aliases: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    identity_files: Vec<String>,
    proxy_jump: Option<String>,
}

impl HostBlockAccumulator {
    fn new(aliases: Vec<String>) -> Self {
        Self {
            aliases,
            host_name: None,
            user: None,
            identity_files: Vec::new(),
            proxy_jump: None,
        }
    }

    fn finalise_into(self, details: &mut Vec<HostDetail>) {
        for alias in self.aliases {
            details.push(HostDetail {
                alias,
                host_name: self.host_name.clone(),
                user: self.user.clone(),
                identity_files: self.identity_files.clone(),
                proxy_jump: self.proxy_jump.clone(),
            });
        }
    }
}

fn apply_attribute(acc: &mut HostBlockAccumulator, line: &str) {
    // Honour ssh's "first directive wins" precedence for scalar
    // attributes — we only set them when not already set, so an
    // outer-scope override doesn't surface a value the inner Host
    // block has already pinned.
    if let Some(rest) = strip_keyword(line, "HostName") {
        if !rest.is_empty() && acc.host_name.is_none() {
            acc.host_name = Some(rest.to_string());
        }
        return;
    }
    if let Some(rest) = strip_keyword(line, "User") {
        if !rest.is_empty() && acc.user.is_none() {
            acc.user = Some(rest.to_string());
        }
        return;
    }
    if let Some(rest) = strip_keyword(line, "IdentityFile") {
        if !rest.is_empty() {
            // Tilde-expand so the desktop surfaces an absolute path the
            // operator can click through. Multiple IdentityFile lines
            // accumulate; ssh tries them in order.
            acc.identity_files.push(expand_tilde(rest));
        }
        return;
    }
    if let Some(rest) = strip_keyword(line, "ProxyJump") {
        if !rest.is_empty() && acc.proxy_jump.is_none() {
            acc.proxy_jump = Some(rest.to_string());
        }
    }
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

    // ── Match blocks (phase 21d) ──────────────────────────────────

    #[test]
    fn match_user_block_active_when_user_matches_literal() {
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user me
Host gated
    HostName 10.0.0.1
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("me"));
        assert_eq!(hosts, vec!["gated"]);
    }

    #[test]
    fn match_user_block_inactive_when_user_does_not_match() {
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user me
Host gated
    HostName 10.0.0.1

Host always
    HostName 10.0.0.2
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("someone-else"));
        // `gated` is dropped because the Match block excluded it.
        // `always` is OUTSIDE the Match block — `Host` resets the
        // gate to active, so this one still surfaces.
        assert_eq!(hosts, vec!["always"]);
    }

    #[test]
    fn match_all_is_always_active() {
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match all
Host gated-by-all
",
        )]);
        // `Match all` should activate regardless of user.
        let with_user = parse_hosts_from_path_with_user(&root, Some("a"));
        let without_user = parse_hosts_from_path_with_user(&root, None);
        assert_eq!(with_user, vec!["gated-by-all"]);
        assert_eq!(without_user, vec!["gated-by-all"]);
    }

    #[test]
    fn match_user_supports_glob_wildcard() {
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user dev-*
Host gated
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("dev-david"));
        assert_eq!(hosts, vec!["gated"]);
        let miss = parse_hosts_from_path_with_user(&root, Some("prod-someone"));
        assert!(miss.is_empty(), "non-matching user must drop the block");
    }

    #[test]
    fn match_user_supports_comma_separated_alternatives() {
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user alice,bob,carol
Host shared
",
        )]);
        for who in ["alice", "bob", "carol"] {
            let hosts = parse_hosts_from_path_with_user(&root, Some(who));
            assert_eq!(hosts, vec!["shared".to_string()], "user={who}");
        }
        let miss = parse_hosts_from_path_with_user(&root, Some("dave"));
        assert!(miss.is_empty(), "user not in list must drop block");
    }

    #[test]
    fn match_user_supports_negated_entry_short_circuiting() {
        // ssh's pattern-list rule: a matching negation rejects the
        // whole list regardless of other matches that follow.
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user *,!banned
Host gated
",
        )]);
        let allowed = parse_hosts_from_path_with_user(&root, Some("alice"));
        assert_eq!(allowed, vec!["gated"]);
        let banned = parse_hosts_from_path_with_user(&root, Some("banned"));
        assert!(banned.is_empty(), "negated entry must reject the block");
    }

    #[test]
    fn match_host_is_treated_as_always_active_for_alias_collection() {
        // We don't know the destination host at suggestion-list time,
        // so any alias gated only on `Match host` should surface.
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match host *.example.com
Host bastion
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("any-user"));
        assert_eq!(hosts, vec!["bastion"]);
    }

    #[test]
    fn match_exec_block_is_dropped_with_a_debug_log() {
        // `exec`-based gating runs an external command — way out of
        // scope for a suggestion-list refresh. We drop the block.
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match exec true
Host gated-by-exec

Host always
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("any"));
        // `gated-by-exec` dropped; `always` is outside the block and
        // surfaces.
        assert_eq!(hosts, vec!["always"]);
    }

    #[test]
    fn match_originalhost_block_is_dropped_as_unsupported() {
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match originalhost foo
Host gated
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("any"));
        assert!(
            hosts.is_empty(),
            "unsupported predicates must drop the block: {hosts:?}"
        );
    }

    #[test]
    fn match_compound_user_and_host_both_evaluated() {
        // `Match user X host Y` — host is always active, user gates.
        // With matching user → block active; with non-matching user →
        // inactive (the host arm can't rescue it).
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user me host *.example.com
Host gated
",
        )]);
        let active = parse_hosts_from_path_with_user(&root, Some("me"));
        assert_eq!(active, vec!["gated"]);
        let inactive = parse_hosts_from_path_with_user(&root, Some("not-me"));
        assert!(inactive.is_empty());
    }

    #[test]
    fn match_block_terminated_by_subsequent_host_directive() {
        // `Host` outside any Match should always activate — even when
        // the preceding Match block was inactive.
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user inaccessible
Host gated
Host afterwards
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("real-user"));
        // The Host after the Match block resets the gate to active —
        // `afterwards` surfaces.
        assert_eq!(hosts, vec!["afterwards"]);
    }

    #[test]
    fn match_block_terminated_by_subsequent_match_directive() {
        // Two Match blocks back-to-back — each evaluates independently.
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user inaccessible
Host hidden
Match all
Host shown
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("any"));
        assert_eq!(hosts, vec!["shown"]);
    }

    #[test]
    fn match_user_with_no_current_user_drops_the_block() {
        // `None` means we couldn't resolve `$USER`. Conservative: any
        // user-gated alias stays excluded (we'd rather show fewer
        // suggestions than show ones ssh itself would reject).
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user anyone
Host gated

Host always
",
        )]);
        let hosts = parse_hosts_from_path_with_user(&root, None);
        assert_eq!(hosts, vec!["always"]);
    }

    #[test]
    fn match_blocks_inside_an_included_file_evaluate_independently() {
        // Each file maintains its own Match state — a Match in
        // conf.d/a.conf doesn't leak into conf.d/b.conf, and the
        // including file's state doesn't carry into the included one.
        let (_dir, root) = fixture(&[
            (
                "config",
                "\
Match user inaccessible
Include conf.d/inner.conf
Host outer-shadowed
",
            ),
            (
                "conf.d/inner.conf",
                "\
Match all
Host inner-active
",
            ),
        ]);
        let hosts = parse_hosts_from_path_with_user(&root, Some("any"));
        // - `outer-shadowed` is gated by the outer Match (inactive).
        // - `inner-active` comes from the included file's own
        //   `Match all` block.
        assert_eq!(hosts, vec!["inner-active"]);
    }

    // ── matches_pattern unit tests ────────────────────────────────

    #[test]
    fn pattern_matcher_handles_basic_wildcards() {
        assert!(matches_pattern("foo", "foo"));
        assert!(!matches_pattern("foo", "bar"));
        assert!(matches_pattern("f*", "foobar"));
        assert!(matches_pattern("*bar", "foobar"));
        assert!(matches_pattern("f*r", "foobar"));
        assert!(matches_pattern("?oo", "foo"));
        assert!(!matches_pattern("?oo", "fooo"));
        // Trailing `*` matches the empty suffix.
        assert!(matches_pattern("foo*", "foo"));
        // Backtracking through multiple `*`.
        assert!(matches_pattern("*foo*bar*", "xfooybarz"));
    }

    #[test]
    fn pattern_matcher_rejects_unmatched_remainder() {
        // Pattern is shorter than value with no `*` to absorb.
        assert!(!matches_pattern("foo", "foobar"));
        assert!(!matches_pattern("foobar", "foo"));
    }

    // ── Track B2: per-host detail parser ──────────────────────────

    #[test]
    fn host_details_capture_hostname_user_identity_file_proxy_jump() {
        let cfg = "\
Host dev.box
    HostName 10.0.2.31
    User dwork
    IdentityFile ~/.ssh/work_rsa
    ProxyJump bastion.example.com
";
        let details = parse_host_details(cfg);
        assert_eq!(details.len(), 1);
        let d = &details[0];
        assert_eq!(d.alias, "dev.box");
        assert_eq!(d.host_name.as_deref(), Some("10.0.2.31"));
        assert_eq!(d.user.as_deref(), Some("dwork"));
        // ~/ should have expanded against $HOME (or stayed literal if
        // $HOME is missing on the test runner — assert prefix).
        assert!(
            d.identity_files
                .first()
                .map(|p| p.ends_with("/.ssh/work_rsa"))
                .unwrap_or(false),
            "identity_files: {:?}",
            d.identity_files,
        );
        assert_eq!(d.proxy_jump.as_deref(), Some("bastion.example.com"));
    }

    #[test]
    fn host_details_aggregate_multiple_identity_files_in_order() {
        let cfg = "\
Host fans-out
    IdentityFile ~/.ssh/primary
    IdentityFile ~/.ssh/fallback
";
        let details = parse_host_details(cfg);
        assert_eq!(details.len(), 1);
        let d = &details[0];
        assert_eq!(d.identity_files.len(), 2);
        assert!(d.identity_files[0].ends_with("/.ssh/primary"));
        assert!(d.identity_files[1].ends_with("/.ssh/fallback"));
    }

    #[test]
    fn host_details_with_multi_alias_line_get_one_entry_per_alias_sharing_body() {
        let cfg = "\
Host alpha beta
    HostName shared.example.com
    User dwork
";
        let details = parse_host_details(cfg);
        let names: Vec<_> = details.iter().map(|d| d.alias.clone()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        for d in &details {
            assert_eq!(d.host_name.as_deref(), Some("shared.example.com"));
            assert_eq!(d.user.as_deref(), Some("dwork"));
        }
    }

    #[test]
    fn host_details_drop_wildcard_host_blocks() {
        // Wildcard Host blocks (e.g. `Host *`) aren't connectable
        // aliases — they're config defaults. Mirror the alias parser
        // and drop them from the detail list.
        let cfg = "\
Host *
    User defaultuser

Host real
    HostName actual.example.com
";
        let details = parse_host_details(cfg);
        let names: Vec<_> = details.iter().map(|d| d.alias.clone()).collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn host_details_terminate_block_at_next_host_directive() {
        // Attributes from block A must not leak into block B.
        let cfg = "\
Host alpha
    User dwork
    HostName a.example.com

Host beta
    HostName b.example.com
";
        let details = parse_host_details(cfg);
        let alpha = details.iter().find(|d| d.alias == "alpha").unwrap();
        let beta = details.iter().find(|d| d.alias == "beta").unwrap();
        assert_eq!(alpha.user.as_deref(), Some("dwork"));
        assert_eq!(beta.user, None, "beta must not inherit alpha's User");
    }

    #[test]
    fn host_details_first_value_wins_for_scalar_attrs() {
        // ssh's rule: the first value for HostName/User/ProxyJump
        // sticks. A later directive in the same block is ignored.
        let cfg = "\
Host h
    HostName first.example.com
    HostName second.example.com
    User first-user
    User second-user
    ProxyJump first-jump
    ProxyJump second-jump
";
        let details = parse_host_details(cfg);
        assert_eq!(details.len(), 1);
        let d = &details[0];
        assert_eq!(d.host_name.as_deref(), Some("first.example.com"));
        assert_eq!(d.user.as_deref(), Some("first-user"));
        assert_eq!(d.proxy_jump.as_deref(), Some("first-jump"));
    }

    #[test]
    fn host_details_ignore_lines_outside_any_host_block() {
        // Lines before the first `Host` directive belong to the
        // implicit "global" block; they don't surface as their own
        // detail entry.
        let cfg = "\
HostName ignored.example.com
User ignored-user

Host h
    HostName captured.example.com
";
        let details = parse_host_details(cfg);
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].alias, "h");
        assert_eq!(
            details[0].host_name.as_deref(),
            Some("captured.example.com")
        );
        assert_eq!(details[0].user, None);
    }

    #[test]
    fn host_details_include_resolution_picks_up_attributes_from_included_files() {
        // Verify the include walker carries per-host attributes the
        // same way the alias walker carries names.
        let (_dir, root) = fixture(&[
            (
                "config",
                "\
Include extra.conf
Host local
    HostName local.example.com
",
            ),
            (
                "extra.conf",
                "\
Host included
    HostName included.example.com
    User d
",
            ),
        ]);
        let details = list_user_ssh_host_details_at(&root);
        let names: Vec<_> = details.iter().map(|d| d.alias.clone()).collect();
        assert_eq!(names, vec!["included", "local"]);
        let inc = details.iter().find(|d| d.alias == "included").unwrap();
        assert_eq!(inc.host_name.as_deref(), Some("included.example.com"));
        assert_eq!(inc.user.as_deref(), Some("d"));
    }

    /// Test-only entry point: same as [`list_user_ssh_host_details`]
    /// but takes an explicit path so tests can drive a tempdir
    /// fixture without spoofing `$HOME`.
    fn list_user_ssh_host_details_at(path: &Path) -> Vec<HostDetail> {
        let user = current_user();
        let mut details: Vec<HostDetail> = Vec::new();
        let mut visited: HashSet<PathBuf> = HashSet::new();
        let base_dir = ssh_base_dir_from_config_path(path);
        super::walk_host_details(
            path,
            &base_dir,
            user.as_deref(),
            &mut details,
            &mut visited,
            0,
        );
        details.sort_by(|a, b| a.alias.cmp(&b.alias));
        details
    }

    #[test]
    fn host_details_match_block_user_gates_detail_just_like_alias() {
        // Reuses Match user evaluation. With a non-matching user, the
        // gated block's host is excluded from the detail list.
        let (_dir, root) = fixture(&[(
            "config",
            "\
Match user me
Host gated
    HostName gated.example.com
",
        )]);
        let with_match = parse_hosts_from_path_with_user(&root, Some("me"));
        let without_match = parse_hosts_from_path_with_user(&root, Some("not-me"));
        assert_eq!(with_match, vec!["gated"]);
        assert!(without_match.is_empty(), "{without_match:?}");
    }
}
