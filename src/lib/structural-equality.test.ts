import { describe, expect, it } from "vitest";
import type { PlanReviewPart } from "./api";
import { partsStructurallyEqual } from "./structural-equality";

function planReview(overrides?: Partial<PlanReviewPart>): PlanReviewPart {
	return {
		type: "plan-review",
		toolUseId: "tool-1",
		toolName: "ExitPlanMode",
		plan: "1. Read files\n2. Edit code",
		planFilePath: "/tmp/plan.md",
		allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
		...overrides,
	};
}

function eq(a: PlanReviewPart, b: PlanReviewPart): boolean {
	return partsStructurallyEqual([a], [b]);
}

describe("partsStructurallyEqual — plan-review", () => {
	it("returns true for identical plan-review parts", () => {
		expect(eq(planReview(), planReview())).toBe(true);
	});

	it("returns false when toolUseId differs", () => {
		expect(eq(planReview(), planReview({ toolUseId: "tool-2" }))).toBe(false);
	});

	it("returns false when plan text differs", () => {
		expect(eq(planReview(), planReview({ plan: "different" }))).toBe(false);
	});

	it("returns false when planFilePath differs", () => {
		expect(eq(planReview(), planReview({ planFilePath: "/other.md" }))).toBe(
			false,
		);
	});

	it("returns false when allowedPrompts length differs", () => {
		expect(eq(planReview(), planReview({ allowedPrompts: [] }))).toBe(false);
	});

	it("returns false when allowedPrompts content differs", () => {
		expect(
			eq(
				planReview(),
				planReview({
					allowedPrompts: [{ tool: "Bash", prompt: "different prompt" }],
				}),
			),
		).toBe(false);
	});

	it("treats missing allowedPrompts as empty array", () => {
		expect(
			eq(
				planReview({ allowedPrompts: undefined }),
				planReview({ allowedPrompts: [] }),
			),
		).toBe(true);
	});

	it("returns true when both have null plan", () => {
		expect(eq(planReview({ plan: null }), planReview({ plan: null }))).toBe(
			true,
		);
	});
});
