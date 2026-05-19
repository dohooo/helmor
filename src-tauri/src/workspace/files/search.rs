//! Workspace-wide text search.
//!
//! Backed by `git grep` so gitignore + binary-file skipping come for
//! free; only files git knows about are searched. The handler caps
//! results at [`MAX_SEARCH_RESULTS_HARD_CAP`] so a runaway query
//! (`.` against a 50k-file repo) can't OOM the daemon.
//!
//! Non-git workspaces surface the underlying git failure verbatim —
//! Helmor's tool surface is git-centric, and a silent "no results"
//! fallback would hide a setup mistake.

use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::git::ops::run_git_capture;

/// Default response cap when the caller doesn't pin a `maxResults`.
/// Sized so the JSON payload stays well under any sensible frame
/// limit while still being useful for "find every TODO" passes.
pub const DEFAULT_MAX_SEARCH_RESULTS: u32 = 200;

/// Hard upper bound — clamps callers that ask for more than this so
/// a desktop bug can't ask for a million results and exhaust the
/// daemon's heap. Picked at 10k because that's roughly the upper
/// bound of "useful to render in a panel" before the operator
/// abandons scrolling.
pub const MAX_SEARCH_RESULTS_HARD_CAP: u32 = 10_000;

/// A single match. Mirrors the wire shape `WorkspaceSearchMatch` 1:1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub relative_path: String,
    pub line_number: u32,
    pub line: String,
}

/// Result of [`search_workspace_inner`]. Stays Rust-side; the
/// runtime trait wraps these into the wire-shape `WorkspaceSearchResult`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchResults {
    pub matches: Vec<SearchHit>,
    pub truncated: bool,
}

/// Run a workspace search. Pure synchronous wrapper around `git
/// grep`; the runtime-facing wire wrapper builds the camelCase
/// response on top.
pub fn search_workspace_inner(
    workspace_dir: &Path,
    query: &str,
    max_results: Option<u32>,
    case_insensitive: bool,
    fixed_string: bool,
) -> Result<SearchResults> {
    if query.is_empty() {
        bail!("query must not be empty");
    }
    let cap = clamp_max_results(max_results);
    let workspace_dir_str = workspace_dir.to_str().context(
        "workspace_dir must be valid UTF-8 (git's -C flag does not accept non-UTF-8 paths)",
    )?;

    // git grep flags:
    //   -n         : line numbers
    //   -I         : skip binary files
    //   --no-color : raw `path:line:text` output
    //   --null     : NUL-separate path from rest AND line-no from
    //                content. With `-n` enabled, the per-match wire
    //                shape is `path\0lineno\0text`; without --null
    //                git emits `path:lineno:text` which breaks for
    //                paths containing `:`.
    //   -e <query> : explicit pattern; ensures `--` doesn't swallow
    //                queries starting with `-`.
    //   -i, -F     : case-insensitive / fixed-string knobs.
    let mut args: Vec<String> = vec![
        "-C".into(),
        workspace_dir_str.into(),
        "grep".into(),
        "-n".into(),
        "-I".into(),
        "--no-color".into(),
        "--null".into(),
    ];
    if case_insensitive {
        args.push("-i".into());
    }
    if fixed_string {
        args.push("-F".into());
    }
    args.push("-e".into());
    args.push(query.into());

    // `git grep` exits 1 when there are no matches — that's normal,
    // not a failure. Other non-zero exits are real (not a repo /
    // bad regex / corrupt index). `run_git_capture` surfaces non-zero
    // exits as Err; we trap the "no matches" case explicitly.
    let stdout = match run_git_capture(args, None) {
        Ok(stdout) => stdout,
        Err(err) => {
            // `run_git_capture` collapses git's stderr into the
            // anyhow::Error display. The empty-result case has an
            // empty stderr / stdout, so its display is the exit
            // line — distinguishable from real failures.
            let msg = format!("{err:#}");
            if msg.contains("git exited with status") && !msg.contains("status: 0") {
                // Treat the most common "no matches" exit as empty
                // results. Anything more interesting (parse error,
                // not-a-repo, broken worktree) keeps the legible
                // git-side message and bubbles up.
                if msg.contains("status: 1") || msg.ends_with("status: 1") {
                    return Ok(SearchResults::default());
                }
            }
            return Err(err);
        }
    };
    Ok(parse_git_grep_output(&stdout, cap))
}

fn clamp_max_results(requested: Option<u32>) -> u32 {
    let raw = requested.unwrap_or(DEFAULT_MAX_SEARCH_RESULTS);
    raw.clamp(1, MAX_SEARCH_RESULTS_HARD_CAP)
}

/// Parse `git grep -n --null` output: each line is
/// `<path>\0<line_no>:<text>`. Returns at most `cap` matches and
/// flags `truncated=true` when the limit was hit.
fn parse_git_grep_output(stdout: &str, cap: u32) -> SearchResults {
    let mut matches: Vec<SearchHit> = Vec::new();
    let mut truncated = false;
    for raw_line in stdout.lines() {
        if raw_line.is_empty() {
            continue;
        }
        if matches.len() as u32 >= cap {
            truncated = true;
            break;
        }
        if let Some(hit) = parse_grep_line(raw_line) {
            matches.push(hit);
        }
    }
    SearchResults { matches, truncated }
}

/// Parse one `git grep -n --null` line. Returns `None` for lines
/// that don't fit the expected `<path>\0<line>\0<text>` shape rather
/// than panicking — robust against any future git format tweak.
///
/// `git grep --null -n` uses NUL as the separator both between the
/// path and the line number AND between the line number and the
/// matched text. Two NULs per line.
fn parse_grep_line(line: &str) -> Option<SearchHit> {
    let first_nul = line.find('\0')?;
    let (path, rest) = line.split_at(first_nul);
    let rest = &rest[1..]; // skip the first NUL
    let second_nul = rest.find('\0')?;
    let (line_no_str, text) = rest.split_at(second_nul);
    let text = &text[1..]; // skip the second NUL
    let line_no: u32 = line_no_str.parse().ok()?;
    Some(SearchHit {
        relative_path: path.to_string(),
        line_number: line_no,
        line: text.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        crate::git::ops::run_git(["init", "-b", "main", root.to_str().unwrap()], None).unwrap();
        // Required for `git commit` to land on platforms with no
        // global user.email config.
        crate::git::ops::run_git(
            ["-C", root.to_str().unwrap(), "config", "user.email", "t@t"],
            None,
        )
        .unwrap();
        crate::git::ops::run_git(
            ["-C", root.to_str().unwrap(), "config", "user.name", "Test"],
            None,
        )
        .unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn add_and_commit(root: &Path, message: &str) {
        let root_str = root.to_str().unwrap();
        crate::git::ops::run_git(["-C", root_str, "add", "-A"], None).unwrap();
        crate::git::ops::run_git(
            ["-C", root_str, "commit", "-m", message, "--no-gpg-sign"],
            None,
        )
        .unwrap();
    }

    #[test]
    fn rejects_empty_query() {
        let dir = init_repo();
        let err = search_workspace_inner(dir.path(), "", None, false, false).unwrap_err();
        assert!(format!("{err:#}").contains("query must not be empty"));
    }

    #[test]
    fn finds_matches_with_line_numbers_in_committed_files() {
        let dir = init_repo();
        write(
            dir.path(),
            "src/main.rs",
            "fn main() {\n    println!(\"hello, TODO finish this\");\n}\n",
        );
        write(dir.path(), "lib.rs", "// nothing of interest\n");
        add_and_commit(dir.path(), "seed");

        let result = search_workspace_inner(dir.path(), "TODO", None, false, false).unwrap();

        assert!(!result.truncated);
        assert_eq!(result.matches.len(), 1);
        let hit = &result.matches[0];
        assert_eq!(hit.relative_path, "src/main.rs");
        assert_eq!(hit.line_number, 2);
        assert!(
            hit.line.contains("TODO"),
            "match line should carry the surrounding context: {}",
            hit.line
        );
    }

    #[test]
    fn returns_empty_results_when_pattern_does_not_match() {
        // `git grep` exits 1 on no-match; we trap that as a normal
        // empty result rather than surfacing it as an error.
        let dir = init_repo();
        write(dir.path(), "f.txt", "one\ntwo\n");
        add_and_commit(dir.path(), "seed");

        let result =
            search_workspace_inner(dir.path(), "needle-not-here", None, false, false).unwrap();

        assert!(result.matches.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn truncates_when_hits_exceed_max_results_cap() {
        // 30 matches across 3 files; cap=5 should yield 5 hits + truncated=true.
        let dir = init_repo();
        for f in 0..3 {
            let mut body = String::new();
            for line in 0..10 {
                body.push_str(&format!("hit {f}.{line}\n"));
            }
            write(dir.path(), &format!("f{f}.txt"), &body);
        }
        add_and_commit(dir.path(), "seed");

        let result = search_workspace_inner(dir.path(), "hit", Some(5), false, false).unwrap();

        assert!(result.truncated);
        assert_eq!(result.matches.len(), 5);
    }

    #[test]
    fn case_insensitive_matches_when_flag_is_set() {
        let dir = init_repo();
        write(dir.path(), "f.txt", "Hello WORLD\nlowercase world\n");
        add_and_commit(dir.path(), "seed");

        // case-sensitive: only the lowercase 'world' matches.
        let cs = search_workspace_inner(dir.path(), "world", None, false, false).unwrap();
        assert_eq!(cs.matches.len(), 1);
        assert_eq!(cs.matches[0].line_number, 2);

        // case-insensitive: both 'WORLD' and 'world' match.
        let ci = search_workspace_inner(dir.path(), "world", None, true, false).unwrap();
        assert_eq!(ci.matches.len(), 2);
    }

    #[test]
    fn fixed_string_flag_treats_query_as_literal_not_regex() {
        // Without -F, "a.b" would be a regex (matches `aXb` too).
        // With -F it must match the literal three chars.
        let dir = init_repo();
        write(dir.path(), "f.txt", "literal: a.b\nregex-ish: aXb\n");
        add_and_commit(dir.path(), "seed");

        let regex_hits = search_workspace_inner(dir.path(), "a.b", None, false, false).unwrap();
        assert_eq!(
            regex_hits.matches.len(),
            2,
            "regex `a.b` should match both lines"
        );

        let literal_hits = search_workspace_inner(dir.path(), "a.b", None, false, true).unwrap();
        assert_eq!(
            literal_hits.matches.len(),
            1,
            "fixed-string `a.b` should only match the literal line"
        );
        assert_eq!(literal_hits.matches[0].line_number, 1);
    }

    #[test]
    fn skips_binary_files_via_i_flag() {
        // A literal NUL byte in the file makes git classify it as
        // binary; `-I` (always on) should skip it.
        let dir = init_repo();
        fs::write(dir.path().join("bin.dat"), b"NEEDLE\0\0\0NEEDLE").unwrap();
        write(dir.path(), "text.txt", "NEEDLE in text\n");
        add_and_commit(dir.path(), "seed");

        let result = search_workspace_inner(dir.path(), "NEEDLE", None, false, false).unwrap();
        // Only the text file's match shows up; the binary file is silent.
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].relative_path, "text.txt");
    }

    #[test]
    fn honors_gitignore() {
        // Files matching .gitignore are unknown to git, so git grep
        // skips them by default. Verifies the gitignore-aware path
        // works without us shelling out to `--no-index`.
        let dir = init_repo();
        write(dir.path(), ".gitignore", "ignored.txt\n");
        write(dir.path(), "ignored.txt", "TARGET match in ignored\n");
        write(dir.path(), "tracked.txt", "TARGET match in tracked\n");
        add_and_commit(dir.path(), "seed");

        let result = search_workspace_inner(dir.path(), "TARGET", None, false, false).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].relative_path, "tracked.txt");
    }

    #[test]
    fn non_git_workspace_surfaces_git_error_to_caller() {
        // A directory that isn't a git repo — the search should
        // bubble git's "not a git repository" message up rather
        // than degrading silently.
        let dir = tempfile::tempdir().unwrap();
        let err = search_workspace_inner(dir.path(), "anything", None, false, false).unwrap_err();
        let msg = format!("{err:#}").to_lowercase();
        assert!(
            msg.contains("not a git repository"),
            "expected git's not-a-repo message: {msg}"
        );
    }

    #[test]
    fn parses_paths_containing_colons_via_null_separator() {
        // Cross-check the dual-NUL separator path: `git grep --null
        // -n` outputs `path\0lineno\0text`, so paths with embedded
        // `:` (unusual but valid on Linux) parse correctly — the
        // colon in the path never collides with the line-number /
        // text boundary.
        let line = "weird:name.txt\x0042\x00matched: line content";
        let hit = parse_grep_line(line).expect("should parse with embedded colon in path");
        assert_eq!(hit.relative_path, "weird:name.txt");
        assert_eq!(hit.line_number, 42);
        assert_eq!(hit.line, "matched: line content");
    }

    #[test]
    fn parses_garbled_line_to_none_rather_than_panicking() {
        // A defensive shape check: a future git tweak (or a corrupted
        // stream) producing a line without `\0` should not crash the
        // parser. Drop the line; the next well-formed one still flows.
        assert!(parse_grep_line("no separator at all").is_none());
        // Only one NUL — missing the second separator between line
        // number and text.
        assert!(parse_grep_line("path\x0042-no-second-nul").is_none());
        // Non-numeric line number portion.
        assert!(parse_grep_line("path\x00not-a-number\x00text").is_none());
    }

    #[test]
    fn clamp_max_results_uses_default_when_none_and_caps_runaway_requests() {
        assert_eq!(clamp_max_results(None), DEFAULT_MAX_SEARCH_RESULTS);
        assert_eq!(clamp_max_results(Some(50)), 50);
        assert_eq!(clamp_max_results(Some(0)), 1, "0 maps to 1, never 0");
        assert_eq!(
            clamp_max_results(Some(u32::MAX)),
            MAX_SEARCH_RESULTS_HARD_CAP,
            "runaway requests must be clamped",
        );
    }
}
