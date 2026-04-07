import { describe, expect, test } from "bun:test";
import {
	buildTitlePrompt,
	parseTitleAndBranch,
	TITLE_GENERATION_TIMEOUT_MS,
} from "../src/title.js";

describe("buildTitlePrompt", () => {
	test("includes the user message verbatim", () => {
		const prompt = buildTitlePrompt("refactor the auth module");
		expect(prompt).toContain("refactor the auth module");
	});

	test("asks for exactly title: and branch: lines", () => {
		const prompt = buildTitlePrompt("anything");
		expect(prompt).toContain("title: <the title>");
		expect(prompt).toContain("branch: <the-branch-name>");
	});

	test("ends with the user message on the last line", () => {
		const prompt = buildTitlePrompt("the last one");
		const lines = prompt.split("\n");
		expect(lines[lines.length - 1]).toBe("the last one");
	});
});

describe("parseTitleAndBranch", () => {
	test("parses well-formed output", () => {
		const raw = "title: Fix auth bug\nbranch: fix-auth-bug";
		const result = parseTitleAndBranch(raw);
		expect(result.title).toBe("Fix auth bug");
		expect(result.branchName).toBe("fix-auth-bug");
	});

	test("strips surrounding ASCII quotes from title", () => {
		const raw = 'title: "Fix auth bug"\nbranch: fix-auth-bug';
		expect(parseTitleAndBranch(raw).title).toBe("Fix auth bug");
	});

	test("strips surrounding curly/smart quotes from title", () => {
		const raw = "title: \u201cFix auth bug\u201d\nbranch: fix-auth-bug";
		expect(parseTitleAndBranch(raw).title).toBe("Fix auth bug");
	});

	test("strips invalid chars from branch (case-sensitive: uppercase also dropped)", () => {
		// Current behavior: the invalid-char regex is case-sensitive, so
		// uppercase letters are dropped alongside punctuation. The title
		// prompt already asks the model for lowercase output, so in practice
		// this only fires on surprise input.
		const raw = "title: something\nbranch: fix-auth-bug_v2";
		expect(parseTitleAndBranch(raw).branchName).toBe("fix-auth-bugv2");
	});

	test("keeps only [a-z0-9-]", () => {
		const raw = "title: x\nbranch: abc-123-def";
		expect(parseTitleAndBranch(raw).branchName).toBe("abc-123-def");
	});

	test("collapses consecutive dashes in branch", () => {
		const raw = "title: x\nbranch: foo---bar----baz";
		expect(parseTitleAndBranch(raw).branchName).toBe("foo-bar-baz");
	});

	test("trims leading/trailing dashes in branch", () => {
		const raw = "title: x\nbranch: -foo-bar-";
		expect(parseTitleAndBranch(raw).branchName).toBe("foo-bar");
	});

	test("case-insensitive TITLE:/BRANCH: prefix match", () => {
		const raw = "TITLE: Hello\nBRANCH: hello";
		const result = parseTitleAndBranch(raw);
		expect(result.title).toBe("Hello");
		expect(result.branchName).toBe("hello");
	});

	test("branchName is undefined when branch line is missing", () => {
		const raw = "title: Hello";
		expect(parseTitleAndBranch(raw).branchName).toBeUndefined();
	});

	test("branchName is undefined when branch parses to empty string", () => {
		const raw = "title: Hello\nbranch: !!!";
		expect(parseTitleAndBranch(raw).branchName).toBeUndefined();
	});

	test("falls back to raw text as title when no title: line", () => {
		const raw = "Some unstructured reply";
		expect(parseTitleAndBranch(raw).title).toBe("Some unstructured reply");
	});

	test("empty raw gives empty title and undefined branch", () => {
		const result = parseTitleAndBranch("");
		expect(result.title).toBe("");
		expect(result.branchName).toBeUndefined();
	});

	test("ignores extra lines between title and branch", () => {
		const raw = "title: Fix it\nsome noise here\nbranch: fix-it";
		const result = parseTitleAndBranch(raw);
		expect(result.title).toBe("Fix it");
		expect(result.branchName).toBe("fix-it");
	});
});

describe("TITLE_GENERATION_TIMEOUT_MS", () => {
	test("is a positive number of milliseconds", () => {
		expect(TITLE_GENERATION_TIMEOUT_MS).toBeGreaterThan(0);
		expect(Number.isFinite(TITLE_GENERATION_TIMEOUT_MS)).toBe(true);
	});
});
