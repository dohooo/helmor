import { describe, expect, it } from "vitest";
import {
	resolveConversationRowHeight,
	resolveStableBottomTailHeight,
	shouldCommitMeasurementUrgently,
} from "./thread-viewport";

describe("resolveStableBottomTailHeight", () => {
	it("is a small 1.5x-viewport floor (the scroll-window union covers the rest)", () => {
		expect(resolveStableBottomTailHeight(800)).toBe(1200);
	});

	it("falls back to the 900px default height when the viewport is unmeasured", () => {
		expect(resolveStableBottomTailHeight(0)).toBe(1350);
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

describe("shouldCommitMeasurementUrgently", () => {
	it("commits urgently for the streaming row regardless of settle state", () => {
		expect(shouldCommitMeasurementUrgently(true, false)).toBe(true);
		expect(shouldCommitMeasurementUrgently(true, true)).toBe(true);
	});

	it("commits urgently during the initial settle so the corrected layout paints first", () => {
		expect(shouldCommitMeasurementUrgently(false, true)).toBe(true);
	});

	it("keeps the transition path for historical rows after the settle", () => {
		expect(shouldCommitMeasurementUrgently(false, false)).toBe(false);
	});
});
