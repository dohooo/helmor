import { describe, expect, test } from "bun:test";
import { listProviderModels, pickFastestCodexModel } from "./model-catalog.js";

describe("Codex model catalog", () => {
	test("lists the GPT-5.6 family with its runtime effort levels", () => {
		const models = listProviderModels("codex");

		expect(models.slice(0, 3).map((model) => model.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]);
		expect(models[0]?.effortLevels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultra",
		]);
		expect(models[1]?.effortLevels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"ultra",
		]);
		expect(models[2]?.effortLevels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	test("uses GPT-5.6 Luna for lightweight background work", () => {
		expect(pickFastestCodexModel()).toBe("gpt-5.6-luna");
	});
});
