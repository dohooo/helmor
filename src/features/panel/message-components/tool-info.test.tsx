import { describe, expect, it } from "vitest";
import { getToolInfo } from "./tool-info";

describe("getToolInfo — WebSearch", () => {
	it("search action shows query", () => {
		const info = getToolInfo("WebSearch", {
			query: "rust testing",
			action: { type: "search", query: "rust testing" },
		});
		expect(info.action).toBe("WebSearch");
		expect(info.detail).toBe("rust testing");
	});

	it("openPage action shows url", () => {
		const info = getToolInfo("WebSearch", {
			query: "",
			action: { type: "openPage", url: "https://example.com/docs" },
		});
		expect(info.action).toBe("Open page");
		expect(info.detail).toBe("https://example.com/docs");
	});

	it("findInPage action shows pattern", () => {
		const info = getToolInfo("WebSearch", {
			query: "",
			action: { type: "findInPage", url: "https://ex.com", pattern: "install" },
		});
		expect(info.action).toBe("Find in page");
		expect(info.detail).toBe("install");
	});

	it("findInPage falls back to url when no pattern", () => {
		const info = getToolInfo("WebSearch", {
			query: "",
			action: { type: "findInPage", url: "https://ex.com/page" },
		});
		expect(info.action).toBe("Find in page");
		expect(info.detail).toBe("https://ex.com/page");
	});

	it("no action defaults to WebSearch with query", () => {
		const info = getToolInfo("WebSearch", { query: "hello world" });
		expect(info.action).toBe("WebSearch");
		expect(info.detail).toBe("hello world");
	});
});

describe("getToolInfo — apply_patch", () => {
	it("single file with diff", () => {
		const info = getToolInfo("apply_patch", {
			changes: [
				{
					path: "/src/lib/utils.ts",
					kind: "modify",
					diff: "--- a/src/lib/utils.ts\n+++ b/src/lib/utils.ts\n@@ -1,3 +1,4 @@\n-old line\n+new line\n+added line\n context",
				},
			],
		});
		expect(info.action).toBe("Edit");
		expect(info.file).toBe("utils.ts");
		expect(info.diffAdd).toBe(2);
		expect(info.diffDel).toBe(1);
		expect(info.files).toBeUndefined();
	});

	it("multi-file with per-file diff stats", () => {
		const info = getToolInfo("apply_patch", {
			changes: [
				{
					path: "/src/a.ts",
					kind: "modify",
					diff: "-removed\n+added1\n+added2",
				},
				{
					path: "/src/b.ts",
					kind: "create",
					diff: "+new file line 1\n+new file line 2\n+new file line 3",
				},
			],
		});
		expect(info.action).toBe("Edit 2 files");
		expect(info.file).toBeUndefined();
		expect(info.diffAdd).toBe(5);
		expect(info.diffDel).toBe(1);
		expect(info.files).toHaveLength(2);
		expect(info.files![0]).toEqual({
			name: "a.ts",
			diffAdd: 2,
			diffDel: 1,
		});
		expect(info.files![1]).toEqual({
			name: "b.ts",
			diffAdd: 3,
			diffDel: undefined,
		});
	});

	it("empty changes array", () => {
		const info = getToolInfo("apply_patch", { changes: [] });
		expect(info.action).toBe("Edit");
		expect(info.file).toBeUndefined();
		expect(info.diffAdd).toBeUndefined();
		expect(info.diffDel).toBeUndefined();
		expect(info.files).toBeUndefined();
	});

	it("changes without diff field", () => {
		const info = getToolInfo("apply_patch", {
			changes: [{ path: "/src/foo.rs", kind: "modify" }],
		});
		expect(info.action).toBe("Edit");
		expect(info.file).toBe("foo.rs");
		expect(info.diffAdd).toBeUndefined();
		expect(info.diffDel).toBeUndefined();
	});

	it("skips +++ and --- header lines in diff", () => {
		const info = getToolInfo("apply_patch", {
			changes: [
				{
					path: "/src/x.ts",
					kind: "modify",
					diff: "--- a/src/x.ts\n+++ b/src/x.ts\n-old\n+new",
				},
			],
		});
		expect(info.diffAdd).toBe(1);
		expect(info.diffDel).toBe(1);
	});

	it("missing changes field falls back gracefully", () => {
		const info = getToolInfo("apply_patch", {});
		expect(info.action).toBe("Edit");
		expect(info.file).toBeUndefined();
		expect(info.files).toBeUndefined();
	});
});
