import { describe, expect, it } from "vitest";
import { isMarkdownPath } from "./editor-session";

describe("isMarkdownPath", () => {
	it("matches common markdown extensions", () => {
		expect(isMarkdownPath("README.md")).toBe(true);
		expect(isMarkdownPath("docs/spec.markdown")).toBe(true);
		expect(isMarkdownPath("blog/post.mdx")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isMarkdownPath("README.MD")).toBe(true);
		expect(isMarkdownPath("CHANGELOG.Md")).toBe(true);
	});

	it("rejects non-markdown extensions", () => {
		expect(isMarkdownPath("App.tsx")).toBe(false);
		expect(isMarkdownPath("notes.txt")).toBe(false);
		expect(isMarkdownPath("config.json")).toBe(false);
		expect(isMarkdownPath("noextension")).toBe(false);
	});

	it("does not match files that merely contain '.md' in the name", () => {
		expect(isMarkdownPath("md-utils.ts")).toBe(false);
		expect(isMarkdownPath("foo.md.bak")).toBe(false);
	});
});
