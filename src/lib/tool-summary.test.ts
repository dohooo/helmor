import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "./api";
import { basename, summarizeToolCall } from "./tool-summary";

function tool(
	toolName: string,
	args: Record<string, unknown> = {},
): ToolCallPart {
	return {
		type: "tool-call",
		toolCallId: "tc-1",
		toolName,
		args,
		argsText: JSON.stringify(args),
	};
}

describe("basename", () => {
	it("returns the trailing segment for posix paths", () => {
		expect(basename("/Users/foo/repo/src/lib/tool-summary.ts")).toBe(
			"tool-summary.ts",
		);
	});

	it("returns the trailing segment for windows paths", () => {
		expect(basename("C:\\Users\\foo\\repo\\src\\lib\\tool-summary.ts")).toBe(
			"tool-summary.ts",
		);
	});

	it("returns the input unchanged when there is no separator", () => {
		expect(basename("file.ts")).toBe("file.ts");
	});

	it("returns empty string when path ends with a separator", () => {
		expect(basename("/foo/bar/")).toBe("");
	});
});

describe("summarizeToolCall", () => {
	it("formats Read with a basename", () => {
		expect(summarizeToolCall(tool("Read", { file_path: "/repo/foo.ts" }))).toBe(
			"Reading foo.ts",
		);
	});

	it("falls back when Read has no file_path", () => {
		expect(summarizeToolCall(tool("Read", {}))).toBe("Reading file");
	});

	it("formats Edit with a basename", () => {
		expect(summarizeToolCall(tool("Edit", { file_path: "/a/b/x.rs" }))).toBe(
			"Editing x.rs",
		);
	});

	it("formats Write with a basename", () => {
		expect(summarizeToolCall(tool("Write", { file_path: "/foo/bar.md" }))).toBe(
			"Writing bar.md",
		);
	});

	it("uses generic apply_patch label", () => {
		expect(summarizeToolCall(tool("apply_patch"))).toBe("Applying patch");
	});

	it("formats Bash with a $ prefix and truncates long commands", () => {
		expect(summarizeToolCall(tool("Bash", { command: "git status" }))).toBe(
			"$ git status",
		);
		const long = "x".repeat(120);
		expect(summarizeToolCall(tool("Bash", { command: long }))).toBe(
			`$ ${"x".repeat(80)}`,
		);
	});

	it("formats Grep with the pattern", () => {
		expect(summarizeToolCall(tool("Grep", { pattern: "useQuery" }))).toBe(
			'Grep "useQuery"',
		);
	});

	it("formats Glob with the pattern", () => {
		expect(summarizeToolCall(tool("Glob", { pattern: "**/*.ts" }))).toBe(
			"Glob **/*.ts",
		);
	});

	it("formats WebFetch with the url", () => {
		expect(
			summarizeToolCall(tool("WebFetch", { url: "https://example.com" })),
		).toBe("Fetching https://example.com");
	});

	it("formats WebSearch with the query", () => {
		expect(summarizeToolCall(tool("WebSearch", { query: "claude code" }))).toBe(
			'Searching "claude code"',
		);
	});

	it("treats Task and Agent as sub-agent runs", () => {
		expect(summarizeToolCall(tool("Task"))).toBe("Running sub-agent");
		expect(summarizeToolCall(tool("Agent"))).toBe("Running sub-agent");
	});

	it("formats TodoWrite", () => {
		expect(summarizeToolCall(tool("TodoWrite"))).toBe("Updating todos");
	});

	it("strips the mcp__ prefix and shows server tool name", () => {
		expect(summarizeToolCall(tool("mcp__github__search_repos"))).toBe(
			"MCP search_repos",
		);
	});

	it("falls back to the raw tool name for unknown tools", () => {
		expect(summarizeToolCall(tool("BrandNewTool"))).toBe("BrandNewTool");
	});
});
