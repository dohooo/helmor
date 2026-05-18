import { describe, expect, it } from "vitest";

import { FALLBACK_ISSUE_TITLE } from "./constants";
import { buildPromptTemplate, splitIssueTitleAndBody } from "./helpers";

describe("splitIssueTitleAndBody", () => {
	it("returns fallback title for empty input", () => {
		expect(splitIssueTitleAndBody("")).toEqual({
			title: FALLBACK_ISSUE_TITLE,
			body: "",
		});
		expect(splitIssueTitleAndBody("   \n  ")).toEqual({
			title: FALLBACK_ISSUE_TITLE,
			body: "",
		});
	});

	it("uses short input as title only with empty body", () => {
		expect(splitIssueTitleAndBody("Short feedback")).toEqual({
			title: "Short feedback",
			body: "",
		});
	});

	it("splits longer input into title and body", () => {
		const long =
			"This is a fairly long feedback that exceeds thirty characters";
		const { title, body } = splitIssueTitleAndBody(long);
		expect(Array.from(title).length).toBe(30);
		expect(body.length).toBeGreaterThan(0);
		expect(`${title}${body}`.replace(/\s/g, "")).toBe(long.replace(/\s/g, ""));
	});

	it("counts Unicode code points, not bytes", () => {
		const chinese =
			"这是一个测试反馈这是一个测试反馈这是一个测试反馈这是一个测试反馈";
		const { title, body } = splitIssueTitleAndBody(chinese);
		expect(Array.from(title).length).toBe(30);
		expect(Array.from(body).length).toBe(Array.from(chinese).length - 30);
	});
});

describe("buildPromptTemplate", () => {
	it("includes the user input + the full contribution lifecycle", () => {
		const prompt = buildPromptTemplate("Button is stuck");
		expect(prompt).toMatchInlineSnapshot(`
			"I'm contributing to dohooo/helmor. Please help me ship this.

			## My feedback
			Button is stuck

			## How to handle this
			1. Explore the code, ask anything unclear, propose a minimal change.
			2. Implement once I agree. Do not commit, push, or open a PR before I say "go ahead".
			3. After my "go ahead": commit, push to origin, then \`gh pr create --repo dohooo/helmor --base main\` with a title and body generated from the diff.

			Reply using the same language I used in the "## My feedback" section above."
		`);
	});
});
