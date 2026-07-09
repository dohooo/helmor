import { describe, expect, it } from "vitest";
import { resolveOfficialEnabled } from "./provider-config";

const AVAILABLE = [
	{ slug: "gpt-5.6-sol" },
	{ slug: "gpt-5.6-terra" },
	{ slug: "gpt-5.6-luna" },
	{ slug: "gpt-5.5" },
	{ slug: "gpt-5.4" },
	{ slug: "gpt-5.4-mini" },
	{ slug: "codex:custom|model" },
];

describe("resolveOfficialEnabled", () => {
	it("defaults Codex to GPT-5.6 models and user-configured custom models", () => {
		expect(resolveOfficialEnabled("codex", null, AVAILABLE)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"codex:custom|model",
		]);
	});

	it("preserves an explicit Codex model selection", () => {
		expect(resolveOfficialEnabled("codex", ["gpt-5.5"], AVAILABLE)).toEqual([
			"gpt-5.5",
		]);
	});

	it("keeps Claude null semantics as all enabled", () => {
		expect(resolveOfficialEnabled("claude", null, AVAILABLE)).toEqual(
			AVAILABLE.map((model) => model.slug),
		);
	});
});
