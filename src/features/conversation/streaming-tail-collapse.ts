import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	ThreadMessageLike,
	ToolCallPart,
} from "@/lib/api";
import { formatSource, translateSource } from "@/lib/i18n";

type ToolCategory = "search" | "read" | "shell" | "other";
type CollapseCategory = "search" | "read" | "shell" | "mixed";

const SEARCH_TOOLS = new Set([
	"grep",
	"glob",
	"web_search",
	"tool_search",
	"search",
	"find_files",
	"search_files",
	"ripgrep",
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

const READ_TOOLS = new Set([
	"read",
	"read_file",
	"web_fetch",
	"list_directory",
	"list_dir",
	"ls",
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

const SHELL_TOOL_NAMES = new Set([
	"bash",
	"run",
	"shell",
	"execute",
	"command",
	"exec",
]);
const SHELL_READONLY_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"nl",
	"less",
	"more",
	"bat",
	"tac",
	"ls",
	"dir",
	"tree",
	"exa",
	"eza",
	"stat",
	"file",
	"wc",
	"du",
	"df",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"find",
	"fd",
	"locate",
	"which",
	"whereis",
	"sed",
	"awk",
	"sort",
	"uniq",
	"cut",
	"tr",
	"rev",
	"paste",
	"join",
	"column",
	"fmt",
	"fold",
	"comm",
	"diff",
	"cmp",
	"echo",
	"printf",
	"pwd",
	"whoami",
	"hostname",
	"uname",
	"env",
	"printenv",
	"date",
	"id",
	"uptime",
	"jq",
	"yq",
]);
const GIT_READONLY_SUBCOMMANDS = new Set([
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
]);

export function stabilizeStreamingMessages(
	messages: ThreadMessageLike[],
): ThreadMessageLike[] {
	if (messages.length < 2) {
		return messages;
	}

	let start = messages.length - 1;
	while (start > 0 && messages[start - 1]?.role === "assistant") {
		start -= 1;
	}
	if (start === messages.length - 1) {
		return messages;
	}

	const assistantRun = messages.slice(start);
	if (assistantRun.some((message) => message.role !== "assistant")) {
		return messages;
	}

	// Codex streaming can temporarily expose the same logical tail as
	// multiple adjacent assistant messages: the stable base snapshot
	// plus the latest pending partial. Merge only that trailing run so
	// compatible read-only tool calls can collapse before the user ever
	// sees the intermediate "two separate rows" state.
	const mergedContent = collapseAssistantParts(
		assistantRun.flatMap((message) => message.content),
		assistantRun.some((message) => message.streaming === true),
	);
	const lastMessage = assistantRun[assistantRun.length - 1]!;
	const firstMessage = assistantRun[0]!;
	const merged: ThreadMessageLike = {
		...lastMessage,
		id: firstMessage.id ?? lastMessage.id,
		createdAt: firstMessage.createdAt ?? lastMessage.createdAt,
		role: "assistant",
		content: mergedContent,
		streaming: assistantRun.some((message) => message.streaming === true)
			? true
			: undefined,
	};

	return [...messages.slice(0, start), merged];
}

function collapseAssistantParts(
	parts: ExtendedMessagePart[],
	active: boolean,
): ExtendedMessagePart[] {
	const result: ExtendedMessagePart[] = [];
	const currentGroup: ToolCallPart[] = [];
	// A streaming turn's thinking block surfaces in BOTH the stable base
	// snapshot and the pending partial when this run is merged — the same
	// reasoning lands twice. Same `__part_id` → duplicate copy (later wins);
	// different adjacent ids → consecutive segments of one thinking phase
	// (omitted thinking splits a phase into many blocks), merged into one
	// chip exactly like Rust `collapse.rs::merge_adjacent_reasoning`.
	const reasoningIndexById = new Map<string, number>();
	// Tool calls dedupe by toolCallId: the pending partial re-sends a tool
	// the base already finalized — without this a phantom copy (empty args,
	// no result, live spinner) renders next to the real card.
	const toolIndexById = new Map<string, number>();

	const flushGroup = () => {
		if (currentGroup.length === 0) {
			return;
		}
		if (currentGroup.length >= 2) {
			result.push(buildCollapsedGroup(currentGroup.splice(0), active));
			return;
		}
		result.push(currentGroup[0]!);
		currentGroup.length = 0;
	};

	const pushGroupTool = (tool: ToolCallPart) => {
		const seen = currentGroup.findIndex(
			(t) => t.toolCallId === tool.toolCallId,
		);
		if (seen === -1) {
			currentGroup.push(tool);
			return;
		}
		// Prefer the copy that carries a result.
		if (tool.result != null || currentGroup[seen]!.result == null) {
			currentGroup[seen] = tool;
		}
	};

	for (const part of parts) {
		if (part.type === "collapsed-group") {
			for (const tool of part.tools) {
				pushGroupTool(tool);
			}
			continue;
		}
		if (
			part.type === "tool-call" &&
			isCollapsibleWithArgs(part.toolName, part.args)
		) {
			pushGroupTool(part);
			continue;
		}
		if (part.type === "reasoning") {
			// Flush first — mirrors Rust collapse.rs: a group of reads must
			// render BEFORE thinking that happened after them.
			flushGroup();
			const seenIdx = reasoningIndexById.get(part.id);
			if (seenIdx !== undefined) {
				// Same logical block already shown — keep the latest copy so
				// newer duration / content wins.
				result[seenIdx] = part;
				continue;
			}
			const prev = result[result.length - 1];
			if (prev?.type === "reasoning") {
				// Adjacent segment of the same thinking phase — fold into the
				// previous chip. Skip the text concat when the previous chip
				// already ends with this text: the pending partial re-sends
				// the in-flight segment the base snapshot already absorbed.
				const text =
					part.text && !prev.text.endsWith(part.text)
						? prev.text
							? `${prev.text}\n\n${part.text}`
							: part.text
						: prev.text;
				const durationMs =
					prev.durationMs != null || part.durationMs != null
						? (prev.durationMs ?? 0) + (part.durationMs ?? 0)
						: undefined;
				const streaming =
					prev.streaming === true || part.streaming === true
						? true
						: (prev.streaming ?? part.streaming);
				result[result.length - 1] = {
					...prev,
					text,
					durationMs,
					streaming,
				};
				continue;
			}
			reasoningIndexById.set(part.id, result.length);
			result.push(part);
			continue;
		}
		if (part.type === "text") {
			// A streaming turn exposes the same assistant text twice when this
			// run is merged: the stable base snapshot carries it (the backend
			// Full includes the in-flight partial) AND the pending partial
			// re-sends it. Text parts have no shared id to dedupe on (unlike
			// reasoning / tool-call), so collapse an adjacent text part when one
			// side is a prefix of the other — keep the longer (newer) copy.
			flushGroup();
			const prev = result[result.length - 1];
			if (prev?.type === "text") {
				const prevText = prev.text ?? "";
				const curText = part.text ?? "";
				if (curText.startsWith(prevText) || prevText.startsWith(curText)) {
					if (curText.length >= prevText.length) {
						result[result.length - 1] = part;
					}
					continue;
				}
			}
			result.push(part);
			continue;
		}
		// Flush so the group stays BEFORE this part — letting reads straddle
		// a reasoning/text block reorders the thread.
		flushGroup();
		if (part.type === "tool-call") {
			const seenIdx = toolIndexById.get(part.toolCallId);
			if (seenIdx !== undefined) {
				const existing = result[seenIdx];
				if (
					existing?.type !== "tool-call" ||
					part.result != null ||
					existing.result == null
				) {
					result[seenIdx] = part;
				}
				continue;
			}
			toolIndexById.set(part.toolCallId, result.length);
		}
		result.push(part);
	}

	flushGroup();
	return result;
}

function buildCollapsedGroup(
	tools: ToolCallPart[],
	active: boolean,
): CollapsedGroupPart {
	const flags = {
		search: false,
		read: false,
		shell: false,
	};
	for (const tool of tools) {
		const category = classifyToolWithArgs(tool.toolName, tool.args);
		if (category === "search") flags.search = true;
		else if (category === "shell") flags.shell = true;
		else flags.read = true;
	}
	const activeKinds =
		Number(flags.search) + Number(flags.read) + Number(flags.shell);
	const category: CollapseCategory =
		activeKinds > 1
			? "mixed"
			: flags.search
				? "search"
				: flags.shell
					? "shell"
					: "read";

	// Mirror Rust `collapse.rs`: only active when streaming AND the last
	// tool has no result yet. The caller's `active` flag means "the
	// overall message is still streaming", but the spinner should stop
	// once every tool in the group has finished.
	const lastToolDone =
		tools.length > 0 && tools[tools.length - 1]!.result != null;
	const groupActive = active && !lastToolDone;

	// Derive a stable id from the first tool's id — mirrors the Rust
	// `CollapsedGroupPart::new` so backend- and frontend-collapsed groups
	// agree on the React key.
	const firstId = tools[0]?.toolCallId ?? "empty";
	return {
		type: "collapsed-group",
		id: `group:${firstId}`,
		category,
		tools,
		active: groupActive,
		summary: buildGroupSummary(tools, groupActive),
	};
}

function buildGroupSummary(tools: ToolCallPart[], active: boolean): string {
	const searchTools: ToolCallPart[] = [];
	const readTools: ToolCallPart[] = [];
	const shellTools: ToolCallPart[] = [];

	for (const tool of tools) {
		const category = classifyToolWithArgs(tool.toolName, tool.args);
		if (category === "search") {
			searchTools.push(tool);
		} else if (category === "shell") {
			shellTools.push(tool);
		} else {
			readTools.push(tool);
		}
	}

	const parts: string[] = [];

	if (searchTools.length > 0) {
		const patterns: string[] = [];
		const seen = new Set<string>();
		for (const tool of searchTools) {
			const pattern = extractPattern(tool.args);
			if (!pattern) continue;
			const truncated = truncate(pattern, 40);
			if (seen.has(truncated)) continue;
			seen.add(truncated);
			patterns.push(truncated);
		}

		if (patterns.length === 1) {
			const verb = active
				? translateSource("composerSearchingFor")
				: translateSource("composerSearchedFor");
			const suffix = searchTools.length > 1 ? ` (${searchTools.length}×)` : "";
			parts.push(`${verb} '${patterns[0]}'${suffix}`);
		} else if (patterns.length > 1) {
			parts.push(
				formatSource(
					active ? "composerSearchingPatterns" : "composerSearchedPatterns",
					{ count: searchTools.length },
				),
			);
		} else {
			parts.push(
				formatSource(
					active ? "composerSearchingTimes" : "composerSearchedTimes",
					{ count: searchTools.length },
				),
			);
		}
	}

	if (readTools.length > 0) {
		const paths = new Set<string>();
		for (const tool of readTools) {
			const filePath = extractFilePath(tool.args);
			if (filePath) paths.add(filePath);
		}
		const count = paths.size > 0 ? paths.size : readTools.length;
		const key =
			parts.length === 0
				? active
					? "composerReadingFiles"
					: "composerReadFiles"
				: active
					? "composerReadingFilesLower"
					: "composerReadFilesLower";
		parts.push(formatSource(key, { count }));
	}

	if (shellTools.length > 0) {
		const key =
			parts.length === 0
				? active
					? "composerRunningCommands"
					: "composerRanCommands"
				: active
					? "composerRunningCommandsLower"
					: "composerRanCommandsLower";
		parts.push(formatSource(key, { count: shellTools.length }));
	}

	if (parts.length === 0) {
		return active
			? translateSource("composerWorking")
			: translateSource("done");
	}
	return active ? `${parts.join(", ")}...` : parts.join(", ");
}

function extractPattern(args: Record<string, unknown>): string | null {
	for (const key of ["pattern", "query", "search", "regex", "glob"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

function extractFilePath(args: Record<string, unknown>): string | null {
	for (const key of ["file_path", "path", "file", "url"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function isCollapsibleWithArgs(
	rawName: string,
	args: Record<string, unknown>,
): boolean {
	const category = classifyToolWithArgs(rawName, args);
	return category === "search" || category === "read" || category === "shell";
}

function classifyToolWithArgs(
	rawName: string,
	args: Record<string, unknown>,
): ToolCategory {
	const normalized = normalizeToolName(rawName);

	if (SEARCH_TOOLS.has(normalized)) return "search";
	if (READ_TOOLS.has(normalized)) return "read";

	if (normalized.startsWith("mcp__")) {
		const toolPart = normalized.split("__").slice(2).join("__");
		if (SEARCH_TOOLS.has(toolPart) || toolPart.startsWith("search")) {
			return "search";
		}
		if (
			READ_TOOLS.has(toolPart) ||
			toolPart.startsWith("read") ||
			toolPart.startsWith("get_") ||
			toolPart.startsWith("list_") ||
			toolPart.startsWith("fetch")
		) {
			return "read";
		}
	}

	if (normalized.startsWith("search_") || normalized.endsWith("_search")) {
		return "search";
	}
	if (
		normalized.startsWith("read_") ||
		normalized.startsWith("get_") ||
		normalized.startsWith("list_") ||
		normalized.startsWith("fetch_")
	) {
		return "read";
	}

	if (SHELL_TOOL_NAMES.has(normalized) && typeof args.command === "string") {
		return classifyShellCommand(args.command);
	}

	return "other";
}

function normalizeToolName(name: string): string {
	return name
		.replace(/-/g, "_")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();
}

function classifyShellCommand(command: string): ToolCategory {
	const inner = unwrapShell(command);
	if (hasOutputRedirect(inner)) {
		return "other";
	}

	const segments = splitShellSegments(inner)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) {
		return "other";
	}

	for (const segment of segments) {
		const commandName = segmentCommand(segment);
		if (!commandName) {
			return "other";
		}
		if (commandName === "git") {
			const subcommand = gitSubcommand(segment);
			if (!subcommand || !GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
				return "other";
			}
			continue;
		}
		if (!SHELL_READONLY_COMMANDS.has(commandName)) {
			return "other";
		}
	}

	return "shell";
}

function unwrapShell(command: string): string {
	const trimmed = command.trim();
	const base = trimmed.split(/\s+/, 1)[0]?.split("/").pop() ?? "";
	if (!["sh", "bash", "zsh", "fish", "dash"].includes(base)) {
		return trimmed;
	}

	let rest = trimmed.slice(trimmed.indexOf(base) + base.length).trimStart();
	while (rest.startsWith("-")) {
		const match = rest.match(/^\S+/);
		if (!match) break;
		rest = rest.slice(match[0].length).trimStart();
	}

	if (
		(rest.startsWith('"') && rest.endsWith('"')) ||
		(rest.startsWith("'") && rest.endsWith("'"))
	) {
		return rest.slice(1, -1);
	}
	return rest;
}

function segmentCommand(segment: string): string | null {
	for (const token of segment.split(/\s+/)) {
		if (!token) continue;
		if (!token.includes("=") || token.startsWith("-")) {
			return token.split("/").pop() ?? token;
		}
	}
	return null;
}

function gitSubcommand(segment: string): string | null {
	const tokens = segment.split(/\s+/).filter(Boolean);
	if ((tokens[0]?.split("/").pop() ?? "") !== "git") {
		return null;
	}

	for (let i = 1; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (!token.startsWith("-")) {
			return token;
		}
		if (
			["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(token)
		) {
			i += 1;
		}
	}
	return null;
}

function hasOutputRedirect(command: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;
		if (quote) {
			if (char === "\\" && quote === '"') {
				i += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === ">") {
			return true;
		}
	}
	return false;
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;

	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;
		if (quote) {
			if (char === "\\" && quote === '"') {
				i += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === ";" || (char === "&" && command[i + 1] === "&")) {
			segments.push(command.slice(start, i));
			start = char === ";" ? i + 1 : i + 2;
			if (char === "&") {
				i += 1;
			}
		}
	}

	segments.push(command.slice(start));
	return segments;
}
