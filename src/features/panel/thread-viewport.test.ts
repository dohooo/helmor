import { describe, expect, it } from "vitest";
import { resolveConversationRowHeight } from "./thread-viewport";

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
