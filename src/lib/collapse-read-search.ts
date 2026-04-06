/**
 * Collapse consecutive search/read tool calls into summary groups.
 *
 * Ported from Claude Code TUI's collapseReadSearchGroups strategy.
 * Operates on MessagePart[] within a single assistant message,
 * replacing sequences of collapsible tool-call parts with a
 * CollapsedGroupPart summary.
 */

import type { MessagePart, ToolCallPart } from "./message-adapter";
import { classifyTool, isCollapsibleTool } from "./tool-classification";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollapsedGroupPart = {
	type: "collapsed-group";
	/** Mixed category when both search and read tools are present */
	category: "search" | "read" | "mixed";
	/** The original tool-call parts in this group */
	tools: ToolCallPart[];
	/** Whether the last tool in the group is still executing */
	active: boolean;
	/** Human-readable summary, e.g. "Searched for 'foo' (2x), read 3 files" */
	summary: string;
};

/** MessagePart extended with the collapsed-group variant. */
export type ExtendedMessagePart = MessagePart | CollapsedGroupPart;

// ---------------------------------------------------------------------------
// Summary text generation
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

/** Extract a search pattern string from tool args. */
function extractPattern(args: Record<string, unknown>): string | null {
	for (const key of ["pattern", "query", "search", "regex", "glob"]) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return null;
}

/** Extract a file path from tool args. */
function extractFilePath(args: Record<string, unknown>): string | null {
	for (const key of ["file_path", "path", "file", "url"]) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return null;
}

/**
 * Build a human-readable summary for a collapsed group.
 *
 * Follows Claude Code TUI's getSearchReadSummaryText format:
 * - Active groups use present tense + "..."
 * - Completed groups use past tense
 * - Patterns are quoted and de-duplicated
 * - File counts are aggregated
 */
export function buildGroupSummary(
	tools: ToolCallPart[],
	active: boolean,
): string {
	const searchTools: ToolCallPart[] = [];
	const readTools: ToolCallPart[] = [];

	for (const t of tools) {
		const cat = classifyTool(t.toolName);
		if (cat === "search") searchTools.push(t);
		else readTools.push(t);
	}

	const parts: string[] = [];

	// Search summary
	if (searchTools.length > 0) {
		const patterns = new Set<string>();
		for (const t of searchTools) {
			const p = extractPattern(t.args);
			if (p) patterns.add(truncate(p, 40));
		}

		if (patterns.size === 1) {
			const pat = [...patterns][0];
			const verb = active ? "Searching for" : "Searched for";
			const countSuffix =
				searchTools.length > 1 ? ` (${searchTools.length}\u00d7)` : "";
			parts.push(`${verb} '${pat}'${countSuffix}`);
		} else if (patterns.size > 1) {
			const verb = active ? "Searching" : "Searched";
			parts.push(`${verb} ${searchTools.length} patterns`);
		} else {
			const verb = active ? "Searching" : "Searched";
			parts.push(
				`${verb} ${searchTools.length} time${searchTools.length > 1 ? "s" : ""}`,
			);
		}
	}

	// Read summary
	if (readTools.length > 0) {
		// Collect unique file paths
		const paths = new Set<string>();
		for (const t of readTools) {
			const p = extractFilePath(t.args);
			if (p) paths.add(p);
		}

		const count = paths.size || readTools.length;
		const verb =
			parts.length === 0
				? active
					? "Reading"
					: "Read"
				: active
					? "reading"
					: "read";
		parts.push(`${verb} ${count} file${count > 1 ? "s" : ""}`);
	}

	if (parts.length === 0) {
		return active ? "Working..." : "Done";
	}

	return parts.join(", ") + (active ? "..." : "");
}

// ---------------------------------------------------------------------------
// Core collapse algorithm
// ---------------------------------------------------------------------------

/**
 * Collapse consecutive collapsible tool-call parts into CollapsedGroupPart.
 *
 * Rules:
 * - Consecutive search/read tool-calls accumulate into a group
 * - A reasoning part passes through without breaking the group
 * - A text part or non-collapsible tool-call flushes the group
 * - Groups of >= 2 tools are collapsed; single tools are kept as-is
 * - The last group in a streaming message is marked active if its
 *   last tool has no result yet
 */
export function collapseToolCallsInParts(
	parts: MessagePart[],
	isStreaming: boolean,
): ExtendedMessagePart[] {
	const result: ExtendedMessagePart[] = [];
	let currentGroup: ToolCallPart[] = [];

	const flushGroup = () => {
		if (currentGroup.length === 0) return;

		if (currentGroup.length >= 2) {
			const cats = currentGroup.map((t) => classifyTool(t.toolName));
			const hasSearch = cats.includes("search");
			const hasRead = cats.includes("read");
			const category: CollapsedGroupPart["category"] =
				hasSearch && hasRead ? "mixed" : hasSearch ? "search" : "read";

			const lastTool = currentGroup[currentGroup.length - 1];
			const active = isStreaming && lastTool.result == null;

			result.push({
				type: "collapsed-group",
				category,
				tools: [...currentGroup],
				active,
				summary: buildGroupSummary(currentGroup, active),
			});
		} else {
			// Single tool — keep original
			result.push(...currentGroup);
		}
		currentGroup = [];
	};

	for (const part of parts) {
		if (part.type === "tool-call" && isCollapsibleTool(part.toolName)) {
			currentGroup.push(part);
		} else if (part.type === "reasoning") {
			// Reasoning passes through without breaking the group
			result.push(part);
		} else {
			// Text or non-collapsible tool — flush current group
			flushGroup();
			result.push(part);
		}
	}

	// Flush trailing group (common during streaming)
	flushGroup();

	return result;
}
