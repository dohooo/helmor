import { describe, expect, it } from "vitest";
import type { ThreadMessageLike } from "./api";
import { hasUnresolvedPlanReview } from "./plan-review";

function msg(
	role: "assistant" | "user",
	parts: { type: string }[] = [{ type: "text" }],
): ThreadMessageLike {
	return {
		role,
		content: parts.map((p) => ({ ...p, text: "x" }) as never),
	};
}

function planMsg(): ThreadMessageLike {
	return msg("assistant", [
		{
			type: "plan-review",
		},
	]);
}

describe("hasUnresolvedPlanReview", () => {
	it("returns false for empty messages", () => {
		expect(hasUnresolvedPlanReview([])).toBe(false);
	});

	it("returns false when no plan-review exists", () => {
		expect(hasUnresolvedPlanReview([msg("user"), msg("assistant")])).toBe(
			false,
		);
	});

	it("returns true when last plan-review has no user message after it", () => {
		expect(hasUnresolvedPlanReview([msg("user"), planMsg()])).toBe(true);
	});

	it("returns false when a user message follows the plan-review", () => {
		expect(hasUnresolvedPlanReview([msg("user"), planMsg(), msg("user")])).toBe(
			false,
		);
	});

	it("returns true for the latest unresolved plan-review among multiple", () => {
		expect(
			hasUnresolvedPlanReview([
				planMsg(),
				msg("user"),
				msg("assistant"),
				planMsg(),
			]),
		).toBe(true);
	});

	it("returns false when all plan-reviews are resolved", () => {
		expect(
			hasUnresolvedPlanReview([planMsg(), msg("user"), planMsg(), msg("user")]),
		).toBe(false);
	});

	it("returns true when plan-review is the only message", () => {
		expect(hasUnresolvedPlanReview([planMsg()])).toBe(true);
	});

	it("ignores assistant messages after plan-review (only user resolves)", () => {
		expect(hasUnresolvedPlanReview([planMsg(), msg("assistant")])).toBe(true);
	});
});
