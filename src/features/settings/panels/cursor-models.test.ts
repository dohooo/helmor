import { describe, expect, test } from "vitest";
import {
	compareVersions,
	extractVersion,
	pickDefaultCursorModelIds,
} from "./cursor-models";

describe("extractVersion", () => {
	test("dot-separated", () => {
		expect(extractVersion("gpt-5.3-codex")).toEqual([5, 3]);
	});
	test("dash-separated", () => {
		expect(extractVersion("claude-sonnet-4-5")).toEqual([4, 5]);
	});
	test("single digit", () => {
		expect(extractVersion("composer-2")).toEqual([2]);
	});
	test("no digits", () => {
		expect(extractVersion("default")).toEqual([0]);
	});
	test("ignores trailing words after first non-digit", () => {
		expect(extractVersion("gpt-5.1-codex-max")).toEqual([5, 1]);
	});
});

describe("compareVersions", () => {
	test("higher major wins", () => {
		expect(compareVersions([5, 3], [4, 9])).toBeGreaterThan(0);
	});
	test("equal majors, higher minor wins", () => {
		expect(compareVersions([5, 3], [5, 2])).toBeGreaterThan(0);
	});
	test("equal", () => {
		expect(compareVersions([5, 3], [5, 3])).toBe(0);
	});
	test("missing slots zero-pad", () => {
		expect(compareVersions([5], [5, 0])).toBe(0);
		expect(compareVersions([5, 1], [5])).toBeGreaterThan(0);
	});
});

describe("pickDefaultCursorModelIds", () => {
	const realCursorModels = [
		{ id: "default", label: "Auto" },
		{ id: "composer-2", label: "Composer 2" },
		{ id: "composer-1.5", label: "Composer 1.5" },
		{ id: "gpt-5.3-codex", label: "Codex 5.3" },
		{ id: "gpt-5.2-codex", label: "Codex 5.2" },
		{ id: "gpt-5.1-codex-max", label: "Codex 5.1 Max" },
		{ id: "gpt-5.1-codex-mini", label: "Codex 5.1 Mini" },
		{ id: "gpt-5.1", label: "GPT-5.1" },
		{ id: "gpt-5-mini", label: "GPT-5 Mini" },
		{ id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
		{ id: "claude-sonnet-4", label: "Sonnet 4" },
		{ id: "gemini-3-flash", label: "Gemini 3 Flash" },
		{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
		{ id: "kimi-k2.5", label: "Kimi K2.5" },
	];

	test("picks Auto + latest GPT + latest Claude from real cursor catalog", () => {
		const ids = pickDefaultCursorModelIds(realCursorModels);
		expect(ids).toEqual(["default", "gpt-5.3-codex", "claude-sonnet-4-5"]);
	});

	test("tie-breaks GPT by shortest id at the top version", () => {
		const ids = pickDefaultCursorModelIds([
			{ id: "default", label: "Auto" },
			{ id: "gpt-5.3-codex-mini", label: "Codex 5.3 Mini" },
			{ id: "gpt-5.3-codex", label: "Codex 5.3" },
		]);
		// Same version 5.3 → shorter id wins.
		expect(ids).toEqual(["default", "gpt-5.3-codex"]);
	});

	test("auto absent, family present", () => {
		const ids = pickDefaultCursorModelIds([
			{ id: "gpt-5.3-codex", label: "Codex 5.3" },
			{ id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
		]);
		expect(ids).toEqual(["gpt-5.3-codex", "claude-sonnet-4-5"]);
	});

	test("only auto", () => {
		const ids = pickDefaultCursorModelIds([{ id: "default", label: "Auto" }]);
		expect(ids).toEqual(["default"]);
	});

	test("empty input returns empty", () => {
		expect(pickDefaultCursorModelIds([])).toEqual([]);
	});
});
