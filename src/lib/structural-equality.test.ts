import { describe, expect, it } from "vitest";
import type { PlanReviewPart, WorkflowPart } from "./api";
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

function workflow(overrides?: Partial<WorkflowPart>): WorkflowPart {
	return {
		type: "workflow",
		id: "workflow:wf_1",
		name: "demo",
		status: "running",
		agents: [
			{ label: "a", status: "done", resultPreview: "alpha" },
			{ label: "b", status: "running" },
		],
		totalTokens: 1000,
		durationMs: 500,
		...overrides,
	};
}

function eqWf(a: WorkflowPart, b: WorkflowPart): boolean {
	return partsStructurallyEqual([a], [b]);
}

describe("partsStructurallyEqual — workflow", () => {
	it("returns true for identical workflow parts", () => {
		expect(eqWf(workflow(), workflow())).toBe(true);
	});

	it("returns false when id differs (distinct runs must not share)", () => {
		expect(eqWf(workflow(), workflow({ id: "workflow:wf_2" }))).toBe(false);
	});

	it("returns false when status changes (running → completed)", () => {
		expect(eqWf(workflow(), workflow({ status: "completed" }))).toBe(false);
	});

	it("returns false when an agent status changes", () => {
		expect(
			eqWf(
				workflow(),
				workflow({
					agents: [
						{ label: "a", status: "done", resultPreview: "alpha" },
						{ label: "b", status: "done" },
					],
				}),
			),
		).toBe(false);
	});

	it("returns false when token total or duration changes", () => {
		expect(eqWf(workflow(), workflow({ totalTokens: 2000 }))).toBe(false);
		expect(eqWf(workflow(), workflow({ durationMs: 999 }))).toBe(false);
	});

	it("returns false when the agent list length differs", () => {
		expect(eqWf(workflow(), workflow({ agents: [] }))).toBe(false);
	});
});
