import { describe, expect, it } from "vitest";
import {
	classifyTool,
	isCollapsibleTool,
	normalizeToolName,
} from "./tool-classification";

describe("normalizeToolName", () => {
	it("converts camelCase to snake_case", () => {
		expect(normalizeToolName("webSearch")).toBe("web_search");
		expect(normalizeToolName("readFile")).toBe("read_file");
		expect(normalizeToolName("getIssue")).toBe("get_issue");
	});

	it("converts kebab-case to snake_case", () => {
		expect(normalizeToolName("web-search")).toBe("web_search");
		expect(normalizeToolName("list-directory")).toBe("list_directory");
	});

	it("lowercases everything", () => {
		expect(normalizeToolName("Grep")).toBe("grep");
		expect(normalizeToolName("WebFetch")).toBe("web_fetch");
	});

	it("leaves snake_case unchanged", () => {
		expect(normalizeToolName("web_search")).toBe("web_search");
		expect(normalizeToolName("read_file")).toBe("read_file");
	});
});

describe("classifyTool", () => {
	it("classifies built-in search tools", () => {
		expect(classifyTool("Grep")).toBe("search");
		expect(classifyTool("Glob")).toBe("search");
		expect(classifyTool("WebSearch")).toBe("search");
		expect(classifyTool("web_search")).toBe("search");
	});

	it("classifies built-in read tools", () => {
		expect(classifyTool("Read")).toBe("read");
		expect(classifyTool("WebFetch")).toBe("read");
		expect(classifyTool("ListDirectory")).toBe("read");
		expect(classifyTool("read_file")).toBe("read");
	});

	it("classifies non-collapsible tools as other", () => {
		expect(classifyTool("Edit")).toBe("other");
		expect(classifyTool("Write")).toBe("other");
		expect(classifyTool("Bash")).toBe("other");
		expect(classifyTool("Agent")).toBe("other");
		expect(classifyTool("Task")).toBe("other");
	});

	it("classifies MCP tools by prefix matching", () => {
		expect(classifyTool("mcp__slack__search_messages")).toBe("search");
		expect(classifyTool("mcp__github__get_issue")).toBe("read");
		expect(classifyTool("mcp__custom__list_items")).toBe("read");
		expect(classifyTool("mcp__custom__fetch_data")).toBe("read");
	});

	it("classifies by heuristic prefixes", () => {
		expect(classifyTool("search_documents")).toBe("search");
		expect(classifyTool("get_user_profile")).toBe("read");
		expect(classifyTool("list_repositories")).toBe("read");
		expect(classifyTool("fetch_page")).toBe("read");
	});
});

describe("isCollapsibleTool", () => {
	it("returns true for search/read tools", () => {
		expect(isCollapsibleTool("Grep")).toBe(true);
		expect(isCollapsibleTool("Read")).toBe(true);
		expect(isCollapsibleTool("WebFetch")).toBe(true);
	});

	it("returns false for non-collapsible tools", () => {
		expect(isCollapsibleTool("Edit")).toBe(false);
		expect(isCollapsibleTool("Bash")).toBe(false);
		expect(isCollapsibleTool("Agent")).toBe(false);
	});
});
