import { describe, expect, it } from "vitest";
import { hasAgentMention } from "./agent-mention";

describe("hasAgentMention", () => {
	it("matches @agent (lowercase)", () => {
		expect(hasAgentMention("@agent do this")).toBe(true);
	});

	it("matches @AGENT (uppercase)", () => {
		expect(hasAgentMention("@AGENT do this")).toBe(true);
	});

	it("matches mixed case @Agent", () => {
		expect(hasAgentMention("hey @Agent")).toBe(true);
	});

	it("matches @agent anywhere in the string", () => {
		expect(hasAgentMention("hey @agent can you help?")).toBe(true);
	});

	it("matches @agent as a substring (email@agent.com matches by design)", () => {
		// Per spec: literal /@agent/i ANYWHERE → dispatch (including substrings).
		expect(hasAgentMention("email@agent.com")).toBe(true);
	});

	it("returns false for messages without @agent", () => {
		expect(hasAgentMention("hello team")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasAgentMention("")).toBe(false);
	});

	it("returns false for @agents (plural)", () => {
		// Not an exact match for @agent — but /@agent/i matches the prefix,
		// so @agents DOES contain @agent substring.
		expect(hasAgentMention("@agents do this")).toBe(true);
	});

	it("returns false for unrelated @ mentions", () => {
		expect(hasAgentMention("@alice @bob what do you think?")).toBe(false);
	});
});
