import { describe, expect, it } from "vitest";
import { resolveOfficialEnabled } from "./provider-config";

const CODEX_AVAILABLE = [
	{ slug: "gpt-5.6-sol" },
	{ slug: "gpt-5.6-terra" },
	{ slug: "gpt-5.6-luna" },
	{ slug: "gpt-5.5" },
	{ slug: "gpt-5.4" },
	{ slug: "gpt-5.4-mini" },
	{ slug: "codex:custom|model" },
];

const CLAUDE_AVAILABLE = [
	{ slug: "claude-fable-5[1m]" },
	{ slug: "claude-opus-4-8[1m]" },
	{ slug: "claude-opus-4-7[1m]" },
	{ slug: "claude-opus-4-6[1m]" },
	{ slug: "sonnet" },
	{ slug: "haiku" },
	{ slug: "claude-custom|gateway|model" },
];

describe("resolveOfficialEnabled", () => {
	it("defaults Codex to GPT-5.6 models and user-configured custom models", () => {
		expect(resolveOfficialEnabled("codex", null, CODEX_AVAILABLE)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"codex:custom|model",
		]);
	});

	it("preserves an explicit Codex model selection", () => {
		expect(
			resolveOfficialEnabled("codex", ["gpt-5.5"], CODEX_AVAILABLE),
		).toEqual(["gpt-5.5"]);
	});

	it("defaults Claude to current models and user-configured custom models", () => {
		expect(resolveOfficialEnabled("claude", null, CLAUDE_AVAILABLE)).toEqual([
			"claude-fable-5[1m]",
			"claude-opus-4-8[1m]",
			"sonnet",
			"haiku",
			"claude-custom|gateway|model",
		]);
	});
});
