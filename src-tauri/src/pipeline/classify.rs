//! Tool name normalization and search/read classification.
//!
//! Ported from `tool-classification.ts`. Determines which tool calls can
//! be grouped into collapsed summaries by the collapse module.

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/// Convert camelCase / kebab-case tool names to snake_case for stable matching.
pub fn normalize_tool_name(name: &str) -> String {
    let mut result = String::with_capacity(name.len() + 4);
    let mut prev_lower = false;

    for ch in name.chars() {
        if ch == '-' {
            result.push('_');
            prev_lower = false;
        } else if ch.is_ascii_uppercase() {
            if prev_lower {
                result.push('_');
            }
            result.push(ch.to_ascii_lowercase());
            prev_lower = false;
        } else {
            result.push(ch);
            prev_lower = ch.is_ascii_lowercase();
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Known tool sets
// ---------------------------------------------------------------------------

/// Tools that perform search-like operations (normalized snake_case names).
const SEARCH_TOOLS: &[&str] = &[
    // Built-in Claude Code tools
    "grep",
    "glob",
    "web_search",
    "tool_search",
    "search",
    "find_files",
    "search_files",
    "ripgrep",
    // Common MCP search tools
    "slack_search",
    "slack_search_messages",
    "github_search_code",
    "github_search_issues",
    "github_search_repositories",
    "linear_search_issues",
    "jira_search_jira_issues",
    "confluence_search",
    "notion_search",
    "gmail_search_messages",
    "gmail_search",
    "google_drive_search",
    "sentry_search_issues",
    "datadog_search_logs",
    "mongodb_find",
];

/// Tools that perform read-like operations (normalized snake_case names).
const READ_TOOLS: &[&str] = &[
    // Built-in Claude Code tools
    "read",
    "read_file",
    "web_fetch",
    "list_directory",
    "list_dir",
    "ls",
    // Common MCP read tools
    "slack_read_channel",
    "slack_get_message",
    "slack_get_channel_history",
    "github_get_file_contents",
    "github_get_issue",
    "github_get_pull_request",
    "github_list_issues",
    "github_list_pull_requests",
    "github_list_commits",
    "github_get_commit",
    "linear_get_issue",
    "jira_get_jira_issue",
    "confluence_get_page",
    "notion_get_page",
    "notion_fetch_page",
    "gmail_read_message",
    "google_drive_fetch",
    "mongodb_aggregate",
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Broad classification of a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCategory {
    Search,
    Read,
    /// Read-only shell command (e.g. `cat`, `nl`, `grep` via Bash tool).
    Shell,
    Other,
}

/// Classify a tool name as search, read, or other.
pub fn classify_tool(raw_name: &str) -> ToolCategory {
    let normalized = normalize_tool_name(raw_name);

    // Exact match
    if SEARCH_TOOLS.contains(&normalized.as_str()) {
        return ToolCategory::Search;
    }
    if READ_TOOLS.contains(&normalized.as_str()) {
        return ToolCategory::Read;
    }

    // MCP tool prefix matching: mcp__server__tool_name
    if let Some(rest) = normalized.strip_prefix("mcp__") {
        if let Some(pos) = rest.find("__") {
            let tool_part = &rest[pos + 2..];
            if SEARCH_TOOLS.contains(&tool_part) {
                return ToolCategory::Search;
            }
            if READ_TOOLS.contains(&tool_part) {
                return ToolCategory::Read;
            }
            // Heuristic prefix matching for MCP tools
            if tool_part.starts_with("search") {
                return ToolCategory::Search;
            }
            if tool_part.starts_with("read")
                || tool_part.starts_with("get_")
                || tool_part.starts_with("list_")
                || tool_part.starts_with("fetch")
            {
                return ToolCategory::Read;
            }
        }
    }

    // Heuristic: bare tool names with search/read prefixes
    if normalized.starts_with("search_") || normalized.ends_with("_search") {
        return ToolCategory::Search;
    }
    if normalized.starts_with("read_")
        || normalized.starts_with("get_")
        || normalized.starts_with("list_")
        || normalized.starts_with("fetch_")
    {
        return ToolCategory::Read;
    }

    ToolCategory::Other
}

/// Whether a tool call can be collapsed into a read/search group.
pub fn is_collapsible(raw_name: &str) -> bool {
    matches!(
        classify_tool(raw_name),
        ToolCategory::Search | ToolCategory::Read
    )
}

// ---------------------------------------------------------------------------
// Shell command inspection
// ---------------------------------------------------------------------------

/// Commands that are always read-only regardless of arguments.
const SHELL_READONLY_COMMANDS: &[&str] = &[
    // file viewing
    "cat", "head", "tail", "nl", "less", "more", "bat", "tac", // directory listing
    "ls", "dir", "tree", "exa", "eza", // file info
    "stat", "file", "wc", "du", "df", // search
    "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "locate", "which", "whereis",
    // text filters (read-only in pipelines)
    "sed", "awk", "sort", "uniq", "cut", "tr", "rev", "paste", "join", "column", "fmt", "fold",
    "comm", "diff", "cmp", // output
    "echo", "printf", // system info
    "pwd", "whoami", "hostname", "uname", "env", "printenv", "date", "id", "uptime",
    // json/yaml
    "jq", "yq",
];

/// Tool names that indicate a bash/shell execution tool.
const SHELL_TOOL_NAMES: &[&str] = &["bash", "run", "shell", "execute", "command", "exec"];

/// Git subcommands that are read-only from the collapse classifier's perspective.
const GIT_READONLY_SUBCOMMANDS: &[&str] = &[
    "show",
    "diff",
    "log",
    "status",
    "blame",
    "grep",
    "rev-parse",
    "ls-files",
    "ls-tree",
    "cat-file",
];

/// Strip shell wrappers like `/bin/zsh -lc "actual command"`.
fn unwrap_shell(cmd: &str) -> &str {
    let t = cmd.trim();
    let first_end = t.find(char::is_whitespace).unwrap_or(t.len());
    let base = t[..first_end].rsplit('/').next().unwrap_or(&t[..first_end]);

    if !matches!(base, "sh" | "bash" | "zsh" | "fish" | "dash") {
        return t;
    }

    // Skip flags (tokens starting with -)
    let mut rest = t[first_end..].trim_start();
    while rest.starts_with('-') {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        rest = rest[end..].trim_start();
    }

    // Strip outer quotes
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &rest[1..rest.len() - 1];
        }
    }
    rest
}

/// Extract the base command name from a pipeline segment,
/// skipping leading env-var assignments like `FOO=bar cmd`.
fn segment_command(segment: &str) -> Option<&str> {
    segment
        .split_whitespace()
        .find(|w| !w.contains('=') || w.starts_with('-'))
        .map(|w| w.rsplit('/').next().unwrap_or(w))
}

fn git_subcommand(segment: &str) -> Option<&str> {
    let mut tokens = segment.split_whitespace().peekable();
    let first = tokens.next()?.rsplit('/').next().unwrap_or("");
    if first != "git" {
        return None;
    }

    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if !token.starts_with('-') {
            return Some(token);
        }

        if matches!(
            token,
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace"
        ) {
            let _ = tokens.next();
        }
    }

    None
}

/// Check for `>` or `>>` outside of quoted strings — indicates output redirect.
fn has_output_redirect(cmd: &str) -> bool {
    let bytes = cmd.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'\'' {
                    i += 1;
                }
            }
            b'"' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'>' => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

/// Split a command string by `&&` and `;` while skipping quoted strings.
///
/// Intentionally does NOT split by `|` — pipe is ambiguous with regex
/// alternation (e.g. `rg "foo|bar"`), and shell quoting after
/// `unwrap_shell` makes it impossible to distinguish reliably.
/// The first command in each pipeline already determines intent.
fn split_shell_segments(cmd: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let bytes = cmd.as_bytes();
    let len = bytes.len();
    let mut start = 0;
    let mut i = 0;

    while i < len {
        match bytes[i] {
            b'\\' => {
                i += 2;
            }
            b'\'' => {
                i += 1;
                while i < len && bytes[i] != b'\'' {
                    i += 1;
                }
                i += 1;
            }
            b'"' => {
                i += 1;
                while i < len && bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'&' if i + 1 < len && bytes[i + 1] == b'&' => {
                segments.push(&cmd[start..i]);
                i += 2;
                start = i;
            }
            b';' => {
                segments.push(&cmd[start..i]);
                i += 1;
                start = i;
            }
            _ => {
                i += 1;
            }
        }
    }
    if start <= len {
        segments.push(&cmd[start..]);
    }
    segments
}

/// Classify a shell command string by inspecting all pipeline components.
fn classify_shell_command(command: &str) -> ToolCategory {
    let inner = unwrap_shell(command);

    if has_output_redirect(inner) {
        return ToolCategory::Other;
    }

    let mut has_any = false;
    for seg in split_shell_segments(inner) {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        has_any = true;
        match segment_command(seg) {
            Some("git") => match git_subcommand(seg) {
                Some(sub) if GIT_READONLY_SUBCOMMANDS.contains(&sub) => {}
                _ => return ToolCategory::Other,
            },
            Some(cmd) if SHELL_READONLY_COMMANDS.contains(&cmd) => {}
            _ => return ToolCategory::Other,
        }
    }

    if has_any {
        ToolCategory::Shell
    } else {
        ToolCategory::Other
    }
}

/// Classify a tool, inspecting shell command args when the tool is a
/// bash/run executor.
pub fn classify_tool_with_args(raw_name: &str, args: &serde_json::Value) -> ToolCategory {
    let base = classify_tool(raw_name);
    if base != ToolCategory::Other {
        return base;
    }
    let normalized = normalize_tool_name(raw_name);
    if SHELL_TOOL_NAMES.contains(&normalized.as_str()) {
        if let Some(cmd) = args.get("command").and_then(serde_json::Value::as_str) {
            return classify_shell_command(cmd);
        }
    }
    ToolCategory::Other
}

/// Whether a tool call can be collapsed, with args-aware shell inspection.
pub fn is_collapsible_with_args(raw_name: &str, args: &serde_json::Value) -> bool {
    matches!(
        classify_tool_with_args(raw_name, args),
        ToolCategory::Search | ToolCategory::Read | ToolCategory::Shell
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_camel_case() {
        assert_eq!(normalize_tool_name("webFetch"), "web_fetch");
        assert_eq!(normalize_tool_name("readFile"), "read_file");
        assert_eq!(normalize_tool_name("Grep"), "grep");
    }

    #[test]
    fn normalize_kebab_case() {
        assert_eq!(normalize_tool_name("web-search"), "web_search");
        assert_eq!(normalize_tool_name("list-dir"), "list_dir");
    }

    #[test]
    fn normalize_already_snake() {
        assert_eq!(normalize_tool_name("read_file"), "read_file");
        assert_eq!(normalize_tool_name("grep"), "grep");
    }

    #[test]
    fn classify_builtin_search() {
        assert_eq!(classify_tool("grep"), ToolCategory::Search);
        assert_eq!(classify_tool("Grep"), ToolCategory::Search);
        assert_eq!(classify_tool("glob"), ToolCategory::Search);
        assert_eq!(classify_tool("web_search"), ToolCategory::Search);
        assert_eq!(classify_tool("webSearch"), ToolCategory::Search);
    }

    #[test]
    fn classify_builtin_read() {
        assert_eq!(classify_tool("read"), ToolCategory::Read);
        assert_eq!(classify_tool("Read"), ToolCategory::Read);
        assert_eq!(classify_tool("web_fetch"), ToolCategory::Read);
        assert_eq!(classify_tool("webFetch"), ToolCategory::Read);
        assert_eq!(classify_tool("ls"), ToolCategory::Read);
        assert_eq!(classify_tool("list_directory"), ToolCategory::Read);
    }

    #[test]
    fn classify_mcp_exact() {
        assert_eq!(
            classify_tool("mcp__github__github_search_code"),
            ToolCategory::Search
        );
        assert_eq!(
            classify_tool("mcp__github__github_get_issue"),
            ToolCategory::Read
        );
    }

    #[test]
    fn classify_mcp_heuristic() {
        assert_eq!(
            classify_tool("mcp__custom__search_widgets"),
            ToolCategory::Search
        );
        assert_eq!(classify_tool("mcp__custom__get_widget"), ToolCategory::Read);
        assert_eq!(classify_tool("mcp__custom__fetch_data"), ToolCategory::Read);
    }

    #[test]
    fn classify_heuristic_prefix_suffix() {
        assert_eq!(classify_tool("search_users"), ToolCategory::Search);
        assert_eq!(classify_tool("full_text_search"), ToolCategory::Search);
        assert_eq!(classify_tool("read_config"), ToolCategory::Read);
        assert_eq!(classify_tool("get_user"), ToolCategory::Read);
        assert_eq!(classify_tool("list_items"), ToolCategory::Read);
        assert_eq!(classify_tool("fetch_data"), ToolCategory::Read);
    }

    #[test]
    fn classify_other() {
        assert_eq!(classify_tool("edit"), ToolCategory::Other);
        assert_eq!(classify_tool("write"), ToolCategory::Other);
        assert_eq!(classify_tool("bash"), ToolCategory::Other);
        assert_eq!(classify_tool("Bash"), ToolCategory::Other);
    }

    #[test]
    fn is_collapsible_check() {
        assert!(is_collapsible("grep"));
        assert!(is_collapsible("Read"));
        assert!(!is_collapsible("edit"));
        assert!(!is_collapsible("Bash"));
    }

    // -- Shell command classification tests ------------------------------------

    #[test]
    fn unwrap_shell_zsh() {
        assert_eq!(
            unwrap_shell(r#"/bin/zsh -lc "nl -ba src/App.tsx""#),
            "nl -ba src/App.tsx"
        );
    }

    #[test]
    fn unwrap_shell_bash() {
        assert_eq!(unwrap_shell(r#"bash -c 'cat foo.txt'"#), "cat foo.txt");
    }

    #[test]
    fn unwrap_shell_no_wrapper() {
        assert_eq!(unwrap_shell("cat foo.txt"), "cat foo.txt");
    }

    #[test]
    fn classify_shell_readonly_simple() {
        assert_eq!(classify_shell_command("cat foo.txt"), ToolCategory::Shell);
        assert_eq!(
            classify_shell_command("nl -ba src/App.tsx"),
            ToolCategory::Shell
        );
        assert_eq!(
            classify_shell_command("head -20 file.rs"),
            ToolCategory::Shell
        );
        assert_eq!(classify_shell_command("ls -la"), ToolCategory::Shell);
    }

    #[test]
    fn classify_shell_readonly_pipeline() {
        assert_eq!(
            classify_shell_command("nl -ba src/App.tsx | sed -n '50,100p'"),
            ToolCategory::Shell
        );
        assert_eq!(
            classify_shell_command("cat foo | grep bar | sort | uniq"),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_shell_readonly_wrapped() {
        assert_eq!(
            classify_shell_command(r#"/bin/zsh -lc "nl -ba src/App.tsx | sed -n '1,10p'""#),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_shell_wrapped_git_show_readonly() {
        assert_eq!(
            classify_shell_command(
                "/bin/zsh -lc 'git show --unified=80 --no-ext-diff 4ca2fe1 -- sidecar/src/claude-session-manager.ts sidecar/test/claude-session-manager.test.ts src-tauri/src/agents/queries.rs src/lib/workspace-helpers.test.ts'"
            ),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_shell_git_show_with_pipe_readonly() {
        assert_eq!(
            classify_shell_command("git show --summary --format=raw 15719566ea | sed -n '1,12p'"),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_shell_write_rejected() {
        assert_eq!(
            classify_shell_command("rm -rf /tmp/foo"),
            ToolCategory::Other
        );
        assert_eq!(classify_shell_command("npm install"), ToolCategory::Other);
        assert_eq!(classify_shell_command("cargo build"), ToolCategory::Other);
        assert_eq!(
            classify_shell_command("/bin/zsh -lc 'git branch -m feature/new-name'"),
            ToolCategory::Other
        );
    }

    #[test]
    fn classify_shell_redirect_rejected() {
        assert_eq!(
            classify_shell_command("echo hello > /tmp/file.txt"),
            ToolCategory::Other
        );
        assert_eq!(
            classify_shell_command("cat foo >> output.txt"),
            ToolCategory::Other
        );
    }

    #[test]
    fn classify_shell_redirect_in_quotes_ok() {
        // `>` inside quotes is not a redirect
        assert_eq!(
            classify_shell_command(r#"grep ">" file.txt"#),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_shell_rg_with_pipe_in_pattern() {
        // `|` inside regex pattern is NOT a pipe operator
        assert_eq!(
            classify_shell_command(
                r#"rg -n "from 'showToast'|function showToast|export .*showToast" src/"#
            ),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_shell_rg_with_escaped_quotes_and_pipes() {
        // Real Codex command with complex quoting
        assert_eq!(
            classify_shell_command(
                r#"rg -n \"from '@hddr/utils/showToast'|from \\\"@hddr/utils/showToast\\\"|function showToast\" packages-pc/hddr"#
            ),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_shell_chained_commands() {
        assert_eq!(
            classify_shell_command("cat a.txt && cat b.txt"),
            ToolCategory::Shell
        );
        assert_eq!(
            classify_shell_command("cat a.txt && rm b.txt"),
            ToolCategory::Other
        );
    }

    #[test]
    fn classify_tool_with_args_bash_readonly() {
        use serde_json::json;
        assert_eq!(
            classify_tool_with_args("Bash", &json!({"command": "cat foo.txt"})),
            ToolCategory::Shell
        );
        assert_eq!(
            classify_tool_with_args("Run", &json!({"command": "nl -ba src/App.tsx"})),
            ToolCategory::Shell
        );
    }

    #[test]
    fn classify_tool_with_args_bash_write() {
        use serde_json::json;
        assert_eq!(
            classify_tool_with_args("Bash", &json!({"command": "npm install"})),
            ToolCategory::Other
        );
    }

    #[test]
    fn classify_tool_with_args_non_shell() {
        use serde_json::json;
        // Non-shell tools still classified by name
        assert_eq!(
            classify_tool_with_args("grep", &json!({"pattern": "foo"})),
            ToolCategory::Search
        );
        assert_eq!(
            classify_tool_with_args("edit", &json!({})),
            ToolCategory::Other
        );
    }

    #[test]
    fn is_collapsible_with_args_check() {
        use serde_json::json;
        assert!(is_collapsible_with_args(
            "Bash",
            &json!({"command": "cat foo"})
        ));
        assert!(is_collapsible_with_args("grep", &json!({"pattern": "x"})));
        assert!(!is_collapsible_with_args(
            "Bash",
            &json!({"command": "npm install"})
        ));
        assert!(!is_collapsible_with_args("edit", &json!({})));
    }
}
