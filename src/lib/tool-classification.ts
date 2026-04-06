/**
 * Tool name normalization and search/read classification.
 *
 * Ported from Claude Code TUI's classifyForCollapse logic.
 * Used by the collapse-read-search module to determine which
 * tool calls can be grouped into collapsed summaries.
 */

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/** Convert camelCase / kebab-case tool names to snake_case for stable matching. */
export function normalizeToolName(name: string): string {
	return name
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.replace(/-/g, "_")
		.toLowerCase();
}

// ---------------------------------------------------------------------------
// Known tool sets
// ---------------------------------------------------------------------------

/**
 * Tools that perform search-like operations.
 * Matching is done on normalized (snake_case) names.
 */
const SEARCH_TOOLS: ReadonlySet<string> = new Set([
	// Built-in Claude Code tools
	"grep",
	"glob",
	"web_search",
	"tool_search",
	"search",
	"find_files",
	"search_files",
	"ripgrep",
	// Common MCP search tools (normalized)
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
]);

/**
 * Tools that perform read-like operations.
 * Matching is done on normalized (snake_case) names.
 */
const READ_TOOLS: ReadonlySet<string> = new Set([
	// Built-in Claude Code tools
	"read",
	"read_file",
	"web_fetch",
	"list_directory",
	"list_dir",
	"ls",
	// Common MCP read tools (normalized)
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
]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ToolCategory = "search" | "read" | "other";

/** Classify a tool name as search, read, or other. */
export function classifyTool(rawName: string): ToolCategory {
	const normalized = normalizeToolName(rawName);

	// Exact match
	if (SEARCH_TOOLS.has(normalized)) return "search";
	if (READ_TOOLS.has(normalized)) return "read";

	// MCP tool prefix matching (mcp__server__tool_name)
	// Extract the tool portion after the second __
	const mcpMatch = normalized.match(/^mcp__[^_]+__(.+)$/);
	if (mcpMatch) {
		const toolPart = mcpMatch[1];
		if (SEARCH_TOOLS.has(toolPart)) return "search";
		if (READ_TOOLS.has(toolPart)) return "read";
		// Heuristic prefix matching for MCP tools
		if (toolPart.startsWith("search")) return "search";
		if (
			toolPart.startsWith("read") ||
			toolPart.startsWith("get_") ||
			toolPart.startsWith("list_") ||
			toolPart.startsWith("fetch")
		)
			return "read";
	}

	// Heuristic: bare tool names with search/read prefixes
	if (normalized.startsWith("search_") || normalized.endsWith("_search"))
		return "search";
	if (
		normalized.startsWith("read_") ||
		normalized.startsWith("get_") ||
		normalized.startsWith("list_") ||
		normalized.startsWith("fetch_")
	)
		return "read";

	return "other";
}

/** Whether a tool call can be collapsed into a read/search group. */
export function isCollapsibleTool(rawName: string): boolean {
	const cat = classifyTool(rawName);
	return cat === "search" || cat === "read";
}
