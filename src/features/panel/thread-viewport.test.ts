import { describe, expect, it } from "vitest";
import {
	resolveConversationRowHeight,
	resolveStableBottomTailHeight,
} from "./thread-viewport";

describe("resolveStableBottomTailHeight", () => {
	it("covers 6x the viewport once expanded", () => {
		expect(resolveStableBottomTailHeight(800, true)).toBe(4800);
	});

	it("covers only 1.5x the viewport before expansion (first frame)", () => {
		expect(resolveStableBottomTailHeight(800, false)).toBe(1200);
	});

	it("falls back to the 900px default height when the viewport is unmeasured", () => {
		expect(resolveStableBottomTailHeight(0, true)).toBe(5400);
		expect(resolveStableBottomTailHeight(0, false)).toBe(1350);
	});
});

describe("resolveConversationRowHeight", () => {
	it("trusts the measured height even when the estimate runs ahead", () => {
		expect(
			resolveConversationRowHeight({
				estimatedHeight: 7710,
				measuredHeight: 512,
			}),
		).toBe(512);
	});

	it("falls back to the estimate when measurement isn't available yet", () => {
		expect(
			resolveConversationRowHeight({
				estimatedHeight: 168,
				measuredHeight: undefined,
			}),
		).toBe(168);
	});
});
