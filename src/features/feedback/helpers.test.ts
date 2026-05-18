import { describe, expect, it } from "vitest";

import { FALLBACK_ISSUE_TITLE } from "./constants";
import {
	buildIssueBody,
	buildIssueTitle,
	buildPlainTextEditorState,
	buildPrHint,
	buildPromptTemplate,
	type EnvironmentInfo,
} from "./helpers";

const env: EnvironmentInfo = {
	os: "macOS",
	appVersion: "1.2.3",
};

describe("buildIssueTitle", () => {
	it("returns fallback for empty input", () => {
		expect(buildIssueTitle("")).toBe(FALLBACK_ISSUE_TITLE);
		expect(buildIssueTitle("   \n  ")).toBe(FALLBACK_ISSUE_TITLE);
	});

	it("takes first line trimmed", () => {
		expect(buildIssueTitle("  Fix the panel flicker\nother details")).toBe(
			"Fix the panel flicker",
		);
	});

	it("preserves short first line as-is", () => {
		expect(buildIssueTitle("Short title")).toBe("Short title");
	});

	it("truncates past 30 characters with an ellipsis", () => {
		const long =
			"This is a fairly long feedback that exceeds thirty characters";
		const result = buildIssueTitle(long);
		// 30 chars + ellipsis
		expect(Array.from(result).length).toBe(31);
		expect(result.endsWith("…")).toBe(true);
	});

	it("counts Unicode code points, not bytes", () => {
		const chinese =
			"这是一个测试反馈这是一个测试反馈这是一个测试反馈这是一个测试反馈";
		const result = buildIssueTitle(chinese);
		// Should keep 30 chars + ellipsis — would have been truncated mid-byte
		// if we used byte-based truncation.
		expect(Array.from(result).length).toBe(31);
		expect(result.endsWith("…")).toBe(true);
	});
});

describe("buildIssueBody", () => {
	it("appends an environment footer", () => {
		const body = buildIssueBody("Something is broken", env);
		expect(body).toContain("Something is broken");
		expect(body).toContain("- OS: macOS");
		expect(body).toContain("- Helmor version: 1.2.3");
		expect(body).toContain("**Environment**");
	});
});

describe("buildPromptTemplate", () => {
	it("includes the user input, environment, and how-to-help section", () => {
		const prompt = buildPromptTemplate("Button is stuck", env);
		expect(prompt).toMatchInlineSnapshot(`
			"I'd like to contribute an improvement to Helmor.

			## My feedback
			Button is stuck

			## Environment
			- OS: macOS
			- Helmor version: 1.2.3

			## How you can help
			Please:
			1. Explore the relevant code to understand current behavior.
			2. Ask clarifying questions if anything is ambiguous.
			3. Propose a minimal, surgical change.
			4. Implement it once we agree on the approach."
		`);
	});
});

describe("buildPrHint", () => {
	it("tells the agent which upstream to open the PR against", () => {
		const hint = buildPrHint();
		expect(hint).toContain("Dohoo/helmor");
		expect(hint).toContain("gh pr create");
		expect(hint).toContain("--base main");
	});
});

describe("buildPlainTextEditorState", () => {
	it("wraps text in a single paragraph", () => {
		const state = buildPlainTextEditorState("Hello") as unknown as {
			root: { children: { children: { text: string }[] }[] };
		};
		expect(state.root.children).toHaveLength(1);
		const paragraph = state.root.children[0];
		expect(paragraph.children).toHaveLength(1);
		expect(paragraph.children[0].text).toBe("Hello");
	});

	it("handles empty text", () => {
		const state = buildPlainTextEditorState("") as unknown as {
			root: { children: { children: unknown[] }[] };
		};
		expect(state.root.children[0].children).toHaveLength(0);
	});
});
