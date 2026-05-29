import { describe, expect, it } from "vitest";
import type { CodexGoalState } from "@/lib/api";
import {
	formatGoalElapsedSeconds,
	formatGoalTokens,
	goalElapsedText,
	goalStatusIndicatorText,
	goalStatusLabel,
	goalTokensText,
} from "./codex-goal-display";

function goal(overrides: Partial<CodexGoalState> = {}): CodexGoalState {
	return {
		threadId: "thread-1",
		objective: "finish the goal",
		status: "active",
		tokenBudget: null,
		tokensUsed: 12_500,
		timeUsedSeconds: 90,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("codex goal display helpers", () => {
	it("formats elapsed time like Codex", () => {
		expect(formatGoalElapsedSeconds(0)).toBe("0s");
		expect(formatGoalElapsedSeconds(59)).toBe("59s");
		expect(formatGoalElapsedSeconds(60)).toBe("1m");
		expect(formatGoalElapsedSeconds(90 * 60)).toBe("1h 30m");
		expect(formatGoalElapsedSeconds(24 * 60 * 60)).toBe("1d 0h 0m");
	});

	it("formats token counts like Codex", () => {
		expect(formatGoalTokens(0)).toBe("0");
		expect(formatGoalTokens(999)).toBe("999");
		expect(formatGoalTokens(1_234)).toBe("1.23K");
		expect(formatGoalTokens(12_500)).toBe("12.5K");
		expect(formatGoalTokens(100_000)).toBe("100K");
		expect(formatGoalTokens(125_000)).toBe("125K");
		expect(formatGoalTokens(1_250_000)).toBe("1.25M");
	});

	it("uses Codex status labels", () => {
		expect(goalStatusLabel("budgetLimited")).toBe("limited by budget");
		expect(goalStatusLabel("usageLimited")).toBe("usage limited");
	});

	it("formats active status metadata for the two-line banner", () => {
		expect(goalStatusIndicatorText(goal({ tokenBudget: 50_000 }))).toBe(
			"Pursuing goal",
		);
		expect(goalElapsedText(goal({ timeUsedSeconds: 60 }))).toBe("1m");
		expect(goalTokensText(goal({ tokensUsed: 12_500 }))).toBe("12.5K tokens");
	});

	it("formats stopped and terminal status indicator text like Codex", () => {
		expect(goalStatusIndicatorText(goal({ status: "paused" }))).toBe(
			"Goal paused (/goal resume)",
		);
		expect(goalStatusIndicatorText(goal({ status: "blocked" }))).toBe(
			"Goal blocked (/goal resume)",
		);
		expect(goalStatusIndicatorText(goal({ status: "usageLimited" }))).toBe(
			"Goal hit usage limits (/goal resume)",
		);
		expect(
			goalStatusIndicatorText(
				goal({
					status: "budgetLimited",
					tokenBudget: 50_000,
					tokensUsed: 51_000,
				}),
			),
		).toBe("Goal unmet (51K / 50K tokens)");
		expect(
			goalStatusIndicatorText(
				goal({ status: "budgetLimited", tokenBudget: null }),
			),
		).toBe("Goal abandoned");
		expect(goalStatusIndicatorText(goal({ status: "complete" }))).toBe(
			"Goal achieved (1m)",
		);
	});
});
