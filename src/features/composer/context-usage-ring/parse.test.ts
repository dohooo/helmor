import { describe, expect, it } from "vitest";
import {
	type ClaudeRichContextUsage,
	formatTokens,
	parseClaudeRateLimits,
	parseClaudeRichMeta,
	parseCodexRateLimits,
	parseStoredMeta,
	resolveContextUsageDisplay,
	ringTier,
	type StoredContextUsageMeta,
} from "./parse";

const CLAUDE_MODEL = "claude-opus-4-7[1m]";

describe("parseStoredMeta", () => {
	it("returns null for empty / null / unparseable input", () => {
		expect(parseStoredMeta(null)).toBeNull();
		expect(parseStoredMeta("")).toBeNull();
		expect(parseStoredMeta("not json")).toBeNull();
		expect(parseStoredMeta("[]")).toBeNull();
		expect(parseStoredMeta("{}")).toBeNull();
	});

	it("parses the baseline shape including modelId", () => {
		const meta = parseStoredMeta(
			JSON.stringify({
				modelId: CLAUDE_MODEL,
				usedTokens: 25_384,
				maxTokens: 1_000_000,
				percentage: 2.5384,
			}),
		);
		expect(meta).toEqual({
			modelId: CLAUDE_MODEL,
			usedTokens: 25_384,
			maxTokens: 1_000_000,
			percentage: 2.5384,
		});
	});

	it("tolerates a row with no modelId (legacy) as empty string", () => {
		const meta = parseStoredMeta(
			JSON.stringify({
				usedTokens: 100,
				maxTokens: 1000,
				percentage: 10,
			}),
		);
		expect(meta?.modelId).toBe("");
	});

	it("computes percentage from used/max when not provided", () => {
		const meta = parseStoredMeta(
			JSON.stringify({
				modelId: "m",
				usedTokens: 500,
				maxTokens: 1000,
			}),
		);
		expect(meta?.percentage).toBe(50);
	});

	it("returns null when used or max is missing", () => {
		expect(
			parseStoredMeta(JSON.stringify({ modelId: "m", usedTokens: 100 })),
		).toBeNull();
		expect(
			parseStoredMeta(JSON.stringify({ modelId: "m", maxTokens: 1000 })),
		).toBeNull();
	});
});

describe("parseClaudeRichMeta", () => {
	it("parses the rich shape including modelId", () => {
		const rich = parseClaudeRichMeta(
			JSON.stringify({
				modelId: CLAUDE_MODEL,
				usedTokens: 1500,
				maxTokens: 200_000,
				percentage: 0.75,
				isAutoCompactEnabled: true,
				categories: [{ name: "Messages", tokens: 800 }],
			}),
		);
		expect(rich).toEqual({
			modelId: CLAUDE_MODEL,
			usedTokens: 1500,
			maxTokens: 200_000,
			percentage: 0.75,
			isAutoCompactEnabled: true,
			categories: [{ name: "Messages", tokens: 800 }],
		});
	});

	it("returns null on malformed input", () => {
		expect(parseClaudeRichMeta(null)).toBeNull();
		expect(parseClaudeRichMeta("{}")).toBeNull();
		expect(parseClaudeRichMeta('{"usedTokens": 100}')).toBeNull();
	});
});

describe("resolveContextUsageDisplay", () => {
	const baselineClaude: StoredContextUsageMeta = {
		modelId: CLAUDE_MODEL,
		usedTokens: 50_000,
		maxTokens: 200_000,
		percentage: 25,
	};

	it("returns `empty` when baseline + rich are both null", () => {
		expect(resolveContextUsageDisplay(null, null)).toEqual({
			kind: "empty",
		});
	});

	it("returns `full` from the baseline record", () => {
		const res = resolveContextUsageDisplay(baselineClaude, null);
		expect(res).toEqual({
			kind: "full",
			modelId: CLAUDE_MODEL,
			usedTokens: 50_000,
			maxTokens: 200_000,
			percentage: 25,
			tier: "default",
			rich: null,
		});
	});

	it("keeps showing the recorded usage even after the composer switched models", () => {
		// Composer model ≠ recorded model is no longer treated as a mismatch:
		// the ring keeps the last-known % until the next turn refreshes it.
		const res = resolveContextUsageDisplay(baselineClaude, null);
		expect(res.kind).toBe("full");
		if (res.kind !== "full") throw new Error("unreachable");
		expect(res.percentage).toBe(25);
	});

	it("trusted rich (non-zero used/max) drives the ring", () => {
		const rich: ClaudeRichContextUsage = {
			modelId: CLAUDE_MODEL,
			usedTokens: 60_000,
			maxTokens: 200_000,
			percentage: 30,
			isAutoCompactEnabled: true,
			categories: [{ name: "Messages", tokens: 60_000 }],
		};
		const res = resolveContextUsageDisplay(baselineClaude, rich);
		expect(res.kind).toBe("full");
		if (res.kind !== "full") throw new Error("unreachable");
		expect(res.usedTokens).toBe(60_000);
		expect(res.percentage).toBe(30);
		expect(res.rich).toBe(rich);
	});

	it("zeroed rich is rejected; baseline keeps the ring intact", () => {
		// Hover-time live fetch can come back with zeroed totals (e.g.
		// resume against a stale provider session id after a model
		// switch). Letting it through would visually blank the ring.
		const rich: ClaudeRichContextUsage = {
			modelId: "claude-sonnet-4-5",
			usedTokens: 0,
			maxTokens: 0,
			percentage: 0,
			isAutoCompactEnabled: false,
			categories: [],
		};
		const res = resolveContextUsageDisplay(baselineClaude, rich);
		expect(res.kind).toBe("full");
		if (res.kind !== "full") throw new Error("unreachable");
		expect(res.usedTokens).toBe(50_000);
		expect(res.percentage).toBe(25);
		// Rich is still attached so the popover can render whatever
		// non-zero categories it carried (here: none).
		expect(res.rich).toBe(rich);
	});

	it("trusted rich is enough on its own when baseline is missing", () => {
		const rich: ClaudeRichContextUsage = {
			modelId: CLAUDE_MODEL,
			usedTokens: 60_000,
			maxTokens: 200_000,
			percentage: 30,
			isAutoCompactEnabled: true,
			categories: [{ name: "Messages", tokens: 60_000 }],
		};
		const res = resolveContextUsageDisplay(null, rich);
		expect(res.kind).toBe("full");
		if (res.kind !== "full") throw new Error("unreachable");
		expect(res.percentage).toBe(30);
	});

	it("returns `empty` when baseline is null and rich is zeroed", () => {
		const rich: ClaudeRichContextUsage = {
			modelId: CLAUDE_MODEL,
			usedTokens: 0,
			maxTokens: 0,
			percentage: 0,
			isAutoCompactEnabled: false,
			categories: [],
		};
		expect(resolveContextUsageDisplay(null, rich)).toEqual({ kind: "empty" });
	});

	it("computes ring tier from percentage", () => {
		const near: StoredContextUsageMeta = {
			...baselineClaude,
			percentage: 85,
		};
		const res = resolveContextUsageDisplay(near, null);
		if (res.kind !== "full") throw new Error("unreachable");
		expect(res.tier).toBe("danger");
	});
});

describe("formatTokens", () => {
	it.each([
		[0, "0"],
		[Number.NaN, "0"],
		[-5, "0"],
		[42, "42"],
		[999, "999"],
		[1_000, "1.0k"],
		[12_345, "12.3k"],
		[1_000_000, "1.0M"],
		[2_500_000, "2.5M"],
	])("%s → %s", (input, expected) => {
		expect(formatTokens(input)).toBe(expected);
	});
});

describe("parseCodexRateLimits", () => {
	const NOW = 1_777_000_000;

	it("returns null for empty / unparseable / shapeless input", () => {
		expect(parseCodexRateLimits(null)).toBeNull();
		expect(parseCodexRateLimits("")).toBeNull();
		expect(parseCodexRateLimits("not json")).toBeNull();
		expect(parseCodexRateLimits("{}")).toBeNull();
	});

	it("parses wham/usage primary_window + secondary_window", () => {
		const display = parseCodexRateLimits(
			JSON.stringify({
				plan_type: "pro",
				rate_limit: {
					primary_window: {
						used_percent: 27,
						limit_window_seconds: 18_000,
						reset_at: NOW + 3600,
					},
					secondary_window: {
						used_percent: 60,
						limit_window_seconds: 604_800,
						reset_at: NOW + 86_400,
					},
				},
				credits: { has_credits: true, unlimited: false, balance: "10.50" },
			}),
			NOW,
		);
		expect(display?.primary).toEqual({
			usedPercent: 27,
			leftPercent: 73,
			label: "5h limit",
			resetsAt: NOW + 3600,
			expired: false,
		});
		expect(display?.secondary?.label).toBe("7d limit");
		expect(display?.notes).toEqual([
			{ label: "Plan", value: "Pro" },
			{ label: "Credits", value: "10.50" },
		]);
	});

	it("renders plan + zero credits when both windows are exhausted/null", () => {
		const display = parseCodexRateLimits(
			JSON.stringify({
				plan_type: "prolite",
				rate_limit: { primary_window: null, secondary_window: null },
				credits: { has_credits: false, unlimited: false, balance: "0" },
			}),
			NOW,
		);
		expect(display?.primary).toBeNull();
		expect(display?.secondary).toBeNull();
		expect(display?.notes).toEqual([
			{ label: "Plan", value: "Prolite" },
			{ label: "Credits", value: "0.00" },
		]);
	});

	it("treats unlimited credits as a sentinel string", () => {
		const display = parseCodexRateLimits(
			JSON.stringify({
				plan_type: "team",
				credits: { unlimited: true, has_credits: true },
			}),
			NOW,
		);
		expect(display?.notes).toEqual([
			{ label: "Plan", value: "Team" },
			{ label: "Credits", value: "Unlimited" },
		]);
	});

	it("marks expired windows when reset_at is in the past", () => {
		const display = parseCodexRateLimits(
			JSON.stringify({
				rate_limit: {
					primary_window: {
						used_percent: 50,
						limit_window_seconds: 18_000,
						reset_at: NOW - 1,
					},
				},
			}),
			NOW,
		);
		expect(display?.primary?.expired).toBe(true);
	});

	it("clamps used_percent into 0-100 and computes leftPercent", () => {
		const display = parseCodexRateLimits(
			JSON.stringify({
				rate_limit: {
					primary_window: { used_percent: -10, limit_window_seconds: 3600 },
					secondary_window: { used_percent: 150, limit_window_seconds: 3600 },
				},
			}),
			NOW,
		);
		expect(display?.primary?.usedPercent).toBe(0);
		expect(display?.primary?.leftPercent).toBe(100);
		expect(display?.secondary?.usedPercent).toBe(100);
		expect(display?.secondary?.leftPercent).toBe(0);
	});

	it("returns null when no windows / plan / credits are usable", () => {
		expect(
			parseCodexRateLimits(
				JSON.stringify({ rate_limit: { primary_window: null } }),
				NOW,
			),
		).toBeNull();
	});

	it("falls back to legacy CLI-pushed shape (camelCase root)", () => {
		const display = parseCodexRateLimits(
			JSON.stringify({
				primary: {
					usedPercent: 27,
					windowDurationMins: 300,
					resetsAt: NOW + 3600,
				},
				secondary: {
					usedPercent: 60,
					windowDurationMins: 10080,
					resetsAt: NOW + 86_400,
				},
				planType: "plus",
			}),
			NOW,
		);
		expect(display?.primary?.label).toBe("5h limit");
		expect(display?.secondary?.label).toBe("7d limit");
		expect(display?.notes).toEqual([{ label: "Plan", value: "Plus" }]);
	});
});

describe("parseClaudeRateLimits", () => {
	const NOW = 1_777_000_000;

	it("returns null for missing / unparseable input", () => {
		expect(parseClaudeRateLimits(null)).toBeNull();
		expect(parseClaudeRateLimits("not json")).toBeNull();
		expect(parseClaudeRateLimits("{}")).toBeNull();
	});

	it("parses five_hour + seven_day into primary/secondary", () => {
		const display = parseClaudeRateLimits(
			JSON.stringify({
				five_hour: { utilization: 12 },
				seven_day: { utilization: 30 },
			}),
			NOW,
		);
		expect(display?.primary?.usedPercent).toBe(12);
		expect(display?.primary?.label).toBe("5h limit");
		expect(display?.secondary?.usedPercent).toBe(30);
		expect(display?.secondary?.label).toBe("7d limit");
		expect(display?.extraWindows).toEqual([]);
	});

	it("collects every seven_day_* field into extraWindows", () => {
		const display = parseClaudeRateLimits(
			JSON.stringify({
				five_hour: { utilization: 1 },
				seven_day: { utilization: 2 },
				seven_day_sonnet: { utilization: 3 },
				seven_day_opus: { utilization: 4 },
				seven_day_omelette: { utilization: 5 },
				seven_day_cowork: { utilization: 6 },
				seven_day_new_window: { utilization: 7 },
			}),
			NOW,
		);

		// Sorted by `id` (claude-cowork → claude-new-window → claude-omelette
		// → claude-opus → claude-sonnet) so the popover order is stable
		// across refetches.
		expect(display?.extraWindows.map((entry) => entry.title)).toEqual([
			"Daily Routines",
			"New Window",
			"Designs",
			"Opus",
			"Sonnet",
		]);
	});

	it("parses ISO resets_at into unix seconds", () => {
		const display = parseClaudeRateLimits(
			JSON.stringify({
				five_hour: {
					utilization: 8,
					resets_at: "2026-04-25T06:30:00.000Z",
				},
			}),
			NOW,
		);
		expect(display?.primary?.resetsAt).toBe(
			Math.floor(Date.parse("2026-04-25T06:30:00.000Z") / 1000),
		);
	});

	it("skips windows with non-numeric utilization", () => {
		const display = parseClaudeRateLimits(
			JSON.stringify({
				five_hour: { utilization: "bad" },
				seven_day: { utilization: 50 },
				seven_day_sonnet: { utilization: null },
			}),
			NOW,
		);
		expect(display?.primary).toBeNull();
		expect(display?.secondary?.usedPercent).toBe(50);
		expect(display?.extraWindows).toEqual([]);
	});

	it("returns null when no usable windows are present", () => {
		expect(
			parseClaudeRateLimits(JSON.stringify({ extra_usage: { foo: 1 } }), NOW),
		).toBeNull();
	});
});

describe("ringTier", () => {
	it.each([
		[0, "default"],
		[59.99, "default"],
		[60, "warning"],
		[79.99, "warning"],
		[80, "danger"],
		[100, "danger"],
	])("%s%% → %s", (input, expected) => {
		expect(ringTier(input)).toBe(expected);
	});
});
