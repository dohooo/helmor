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
}
