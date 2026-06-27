import { describe, expect, test } from "bun:test";
import { normalizeRootSlashCommand } from "./session-manager.js";

describe("normalizeRootSlashCommand", () => {
	test("bare /compact -> /compact", () => {
		expect(normalizeRootSlashCommand("/compact")).toBe("/compact");
	});

	test("/compact with args -> /compact (args dropped)", () => {
		expect(normalizeRootSlashCommand("/compact focus on auth")).toBe(
			"/compact",
		);
	});

	test("bare /context -> /context all", () => {
		expect(normalizeRootSlashCommand("/context")).toBe("/context all");
	});

	test("/context with args -> /context all", () => {
		expect(normalizeRootSlashCommand("/context show usage")).toBe(
			"/context all",
		);
	});

	test("wrapped /compact (helmor preamble + User request marker) -> /compact", () => {
		const wrapped = `<helmor_context>\nYou are running inside Helmor...\n</helmor_context>\n\nUser request:\n/compact`;
		expect(normalizeRootSlashCommand(wrapped)).toBe("/compact");
	});

	test("wrapped /context -> /context all", () => {
		const wrapped = `<helmor_context>\nframing\n</helmor_context>\n\nUser request:\n/context`;
		expect(normalizeRootSlashCommand(wrapped)).toBe("/context all");
	});

	test("prompt with linked-dirs block AND helmor preamble -> command still extracted", () => {
		const wrapped = `<helmor_context>\nframing\n</helmor_context>\n[Linked directories — you have read/write access:\n- /other]\n\nUser request:\n/compact`;
		expect(normalizeRootSlashCommand(wrapped)).toBe("/compact");
	});

	test("/goal is not a recognized root command -> null", () => {
		expect(normalizeRootSlashCommand("/goal fix all bugs")).toBe(null);
	});

	test("normal prompt -> null", () => {
		expect(normalizeRootSlashCommand("fix the bug in auth.ts")).toBe(null);
	});

	test("wrapped normal prompt -> null", () => {
		const wrapped = `<helmor_context>\nframing\n</helmor_context>\n\nUser request:\nfix the bug in auth.ts`;
		expect(normalizeRootSlashCommand(wrapped)).toBe(null);
	});

	test("command-like text not at the end (mid-prompt) -> null", () => {
		const wrapped = `<helmor_context>\nframing\n</helmor_context>\n\nUser request:\nPlease run /compact for me`;
		expect(normalizeRootSlashCommand(wrapped)).toBe(null);
	});
});
