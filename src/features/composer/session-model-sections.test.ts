import { describe, expect, it } from "vitest";
import type { AgentModelSection } from "@/lib/api";
import { includePinnedHiddenModel } from "./session-model-sections";

const SECTIONS: AgentModelSection[] = [
	{
		id: "codex",
		label: "Codex",
		status: "ready",
		options: [
			{
				id: "gpt-5.6-sol",
				provider: "codex",
				label: "GPT-5.6 Sol",
				cliModel: "gpt-5.6-sol",
			},
		],
	},
];

describe("includePinnedHiddenModel", () => {
	it("keeps the hidden model available to an existing Codex session", () => {
		const result = includePinnedHiddenModel(SECTIONS, {
			agentType: "codex",
			model: "gpt-5.5",
		});

		expect(result[0]?.options.map((model) => model.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.5",
		]);
	});

	it("keeps a hidden Opus model available to an existing Claude session", () => {
		const result = includePinnedHiddenModel([], {
			agentType: "claude",
			model: "claude-opus-4-7[1m]",
		});

		expect(result[0]).toEqual(
			expect.objectContaining({
				id: "claude",
				options: [expect.objectContaining({ id: "claude-opus-4-7[1m]" })],
			}),
		);
	});

	it("does not add a legacy model to unrelated sessions", () => {
		expect(
			includePinnedHiddenModel(SECTIONS, {
				agentType: "claude",
				model: "gpt-5.5",
			}),
		).toBe(SECTIONS);
	});

	it("does not duplicate a legacy model that the user re-enabled", () => {
		const withLegacy = [
			{
				...SECTIONS[0]!,
				options: [
					...SECTIONS[0]!.options,
					{
						id: "gpt-5.5",
						provider: "codex" as const,
						label: "GPT-5.5",
						cliModel: "gpt-5.5",
					},
				],
			},
		];

		expect(
			includePinnedHiddenModel(withLegacy, {
				agentType: "codex",
				model: "gpt-5.5",
			}),
		).toBe(withLegacy);
	});
});
