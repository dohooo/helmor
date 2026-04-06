import { describe, expect, it } from "vitest";
import {
	buildGroupSummary,
	type CollapsedGroupPart,
	collapseToolCallsInParts,
} from "./collapse-read-search";
import type { MessagePart, ToolCallPart } from "./message-adapter";

// Helpers
function tc(
	toolName: string,
	args: Record<string, unknown> = {},
	result?: string,
): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: `tc-${toolName}-${Math.random().toString(36).slice(2, 6)}`,
		toolName,
		args,
		argsText: JSON.stringify(args),
		result,
	};
}

function text(t: string): MessagePart {
	return { type: "text", text: t };
}

function reasoning(t: string): MessagePart {
	return { type: "reasoning", text: t };
}

describe("collapseToolCallsInParts", () => {
	it("collapses 2+ consecutive search/read tools into a group", () => {
		const parts: MessagePart[] = [
			tc("Grep", { pattern: "foo" }, "found 3"),
			tc("Read", { file_path: "src/a.ts" }, "content"),
			tc("Read", { file_path: "src/b.ts" }, "content"),
		];

		const result = collapseToolCallsInParts(parts, false);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveProperty("type", "collapsed-group");

		const group = result[0] as CollapsedGroupPart;
		expect(group.tools).toHaveLength(3);
		expect(group.category).toBe("mixed");
		expect(group.active).toBe(false);
		expect(group.summary).toContain("Searched");
		expect(group.summary).toContain("read 2 files");
	});

	it("does not collapse a single tool", () => {
		const parts: MessagePart[] = [tc("Grep", { pattern: "foo" }, "found")];

		const result = collapseToolCallsInParts(parts, false);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveProperty("type", "tool-call");
	});

	it("breaks group on text part", () => {
		const parts: MessagePart[] = [
			tc("Grep", { pattern: "a" }, "r1"),
			tc("Read", { file_path: "x.ts" }, "r2"),
			text("Based on my analysis..."),
			tc("Read", { file_path: "y.ts" }, "r3"),
		];

		const result = collapseToolCallsInParts(parts, false);
		// [collapsed(2), text, read(1 — not collapsed)]
		expect(result).toHaveLength(3);
		expect(result[0]).toHaveProperty("type", "collapsed-group");
		expect(result[1]).toHaveProperty("type", "text");
		expect(result[2]).toHaveProperty("type", "tool-call");
	});

	it("reasoning passes through without breaking the group", () => {
		const parts: MessagePart[] = [
			tc("Grep", { pattern: "a" }, "r1"),
			reasoning("Thinking about this..."),
			tc("Read", { file_path: "x.ts" }, "r2"),
		];

		const result = collapseToolCallsInParts(parts, false);
		// reasoning passes through, but Grep+Read still form a group
		expect(result).toHaveLength(2);
		expect(result[0]).toHaveProperty("type", "reasoning");
		expect(result[1]).toHaveProperty("type", "collapsed-group");
		expect((result[1] as CollapsedGroupPart).tools).toHaveLength(2);
	});

	it("breaks group on non-collapsible tool", () => {
		const parts: MessagePart[] = [
			tc("Grep", { pattern: "a" }, "r1"),
			tc("Read", { file_path: "x.ts" }, "r2"),
			tc("Edit", { file_path: "x.ts", new_string: "new" }, "ok"),
			tc("Read", { file_path: "y.ts" }, "r3"),
		];

		const result = collapseToolCallsInParts(parts, false);
		// [collapsed(2), Edit, Read(single)]
		expect(result).toHaveLength(3);
		expect(result[0]).toHaveProperty("type", "collapsed-group");
		expect(result[1]).toHaveProperty("type", "tool-call");
		expect((result[1] as ToolCallPart).toolName).toBe("Edit");
		expect(result[2]).toHaveProperty("type", "tool-call");
	});

	it("marks last group as active during streaming when last tool has no result", () => {
		const parts: MessagePart[] = [
			tc("Grep", { pattern: "a" }, "r1"),
			tc("Read", { file_path: "x.ts" }), // no result yet
		];

		const result = collapseToolCallsInParts(parts, true);
		expect(result).toHaveLength(1);
		const group = result[0] as CollapsedGroupPart;
		expect(group.active).toBe(true);
		expect(group.summary).toContain("...");
	});

	it("marks group as not active when all tools have results", () => {
		const parts: MessagePart[] = [
			tc("Grep", { pattern: "a" }, "r1"),
			tc("Read", { file_path: "x.ts" }, "r2"),
		];

		const result = collapseToolCallsInParts(parts, true);
		expect(result).toHaveLength(1);
		const group = result[0] as CollapsedGroupPart;
		expect(group.active).toBe(false);
	});

	it("handles empty parts array", () => {
		expect(collapseToolCallsInParts([], false)).toEqual([]);
	});

	it("handles parts with no collapsible tools", () => {
		const parts: MessagePart[] = [
			text("Hello"),
			tc("Edit", {}, "ok"),
			tc("Bash", { command: "ls" }, "files"),
		];

		const result = collapseToolCallsInParts(parts, false);
		expect(result).toHaveLength(3);
		expect(result.every((p) => p.type !== "collapsed-group")).toBe(true);
	});
});

describe("buildGroupSummary", () => {
	it("generates search summary with pattern", () => {
		const tools = [tc("Grep", { pattern: "TODO" })];
		expect(buildGroupSummary(tools, false)).toBe("Searched for 'TODO'");
	});

	it("generates search summary with count for duplicates", () => {
		const tools = [
			tc("Grep", { pattern: "foo" }),
			tc("Grep", { pattern: "foo" }),
		];
		expect(buildGroupSummary(tools, false)).toBe(
			"Searched for 'foo' (2\u00d7)",
		);
	});

	it("generates read summary with file count", () => {
		const tools = [
			tc("Read", { file_path: "a.ts" }),
			tc("Read", { file_path: "b.ts" }),
		];
		expect(buildGroupSummary(tools, false)).toBe("Read 2 files");
	});

	it("generates mixed summary", () => {
		const tools = [
			tc("Grep", { pattern: "bar" }),
			tc("Read", { file_path: "a.ts" }),
			tc("Read", { file_path: "b.ts" }),
		];
		const summary = buildGroupSummary(tools, false);
		expect(summary).toContain("Searched for 'bar'");
		expect(summary).toContain("read 2 files");
	});

	it("uses present tense and ellipsis when active", () => {
		const tools = [
			tc("Grep", { pattern: "x" }),
			tc("Read", { file_path: "a.ts" }),
		];
		const summary = buildGroupSummary(tools, true);
		expect(summary).toContain("Searching");
		expect(summary).toContain("reading");
		expect(summary.endsWith("...")).toBe(true);
	});

	it("uses past tense when not active", () => {
		const tools = [
			tc("Grep", { pattern: "x" }),
			tc("Read", { file_path: "a.ts" }),
		];
		const summary = buildGroupSummary(tools, false);
		expect(summary).toContain("Searched");
		expect(summary).toContain("read");
		expect(summary).not.toContain("...");
	});
});
