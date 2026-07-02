import { describe, expect, it } from "vitest";
import {
	beginAgentStreamOpen,
	isAgentStreamOpened,
	markAgentStreamOpened,
} from "./agent-stream-open";

// WP8: the per-session "stream POST opened" bit that splits the pre-first-token
// wait into Waking (before open) and Thinking (after open).

describe("agent-stream-open", () => {
	it("starts un-opened, flips on markAgentStreamOpened", () => {
		expect(isAgentStreamOpened("s1")).toBe(false);
		markAgentStreamOpened("s1");
		expect(isAgentStreamOpened("s1")).toBe(true);
	});

	it("is per-session", () => {
		markAgentStreamOpened("s2");
		expect(isAgentStreamOpened("s2")).toBe(true);
		expect(isAgentStreamOpened("s3")).toBe(false);
	});

	it("a new send resets the previous turn's opened bit", () => {
		markAgentStreamOpened("s4");
		expect(isAgentStreamOpened("s4")).toBe(true);
		beginAgentStreamOpen("s4");
		expect(isAgentStreamOpened("s4")).toBe(false);
	});
});
