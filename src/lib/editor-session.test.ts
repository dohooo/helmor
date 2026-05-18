import { describe, expect, it } from "vitest";
import {
	INDEX_REF,
	isActiveEditorTarget,
	isMarkdownPath,
} from "./editor-session";

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

describe("isActiveEditorTarget", () => {
	// Regression cover for issue #544 follow-up: same file in both Staged
	// and Unstaged must light up exactly one row, not both. The selection
	// test is "does the open editor's diff base match THIS area's refs?".
	it("returns false when target is null/undefined", () => {
		expect(isActiveEditorTarget(null, "HEAD", INDEX_REF)).toBe(false);
		expect(isActiveEditorTarget(undefined, "HEAD", INDEX_REF)).toBe(false);
	});

	it("matches staged area's bases (HEAD ↔ INDEX) only", () => {
		const target = {
			path: "/ws/foo.txt",
			originalRef: "HEAD",
			modifiedRef: INDEX_REF,
		};
		// Same path opened from Staged → matches Staged refs.
		expect(isActiveEditorTarget(target, "HEAD", INDEX_REF)).toBe(true);
		// Same path, but Unstaged refs → must NOT match.
		expect(isActiveEditorTarget(target, INDEX_REF, undefined)).toBe(false);
	});

	it("matches unstaged area's bases (INDEX ↔ worktree) only", () => {
		const target = {
			path: "/ws/foo.txt",
			originalRef: INDEX_REF,
			modifiedRef: undefined,
		};
		expect(isActiveEditorTarget(target, INDEX_REF, undefined)).toBe(true);
		expect(isActiveEditorTarget(target, "HEAD", INDEX_REF)).toBe(false);
	});

	it("treats undefined modifiedRef as a real value (strict equality)", () => {
		// The unstaged area passes modifiedRef=undefined ("read from disk").
		// We rely on `===`, NOT loose truthiness, so an open editor with a
		// real modifiedRef of "" or null does NOT collide with undefined.
		const target = {
			path: "/ws/foo.txt",
			originalRef: INDEX_REF,
			modifiedRef: undefined,
		};
		expect(isActiveEditorTarget(target, INDEX_REF, "")).toBe(false);
	});
});
