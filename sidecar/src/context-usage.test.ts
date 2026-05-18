import { describe, expect, it } from "bun:test";
import {
	buildClaudeRichMeta,
	buildClaudeStoredMeta,
	buildCodexStoredMeta,
} from "./context-usage";

const CLAUDE_MODEL = "claude-opus-4-7[1m]";
const CODEX_MODEL = "gpt-5.1-codex";

describe("buildClaudeStoredMeta", () => {
	it("derives used/max/percentage + stamps modelId when iterations is absent", () => {
		const meta = buildClaudeStoredMeta(
			{
				type: "result",
				usage: {
					input_tokens: 6,
					cache_creation_input_tokens: 12_267,
					cache_read_input_tokens: 13_101,
					output_tokens: 10,
				},
				modelUsage: {
					[CLAUDE_MODEL]: { contextWindow: 1_000_000 },
				},
			},
			CLAUDE_MODEL,
		);
		expect(meta).toEqual({
			modelId: CLAUDE_MODEL,
			usedTokens: 25_384,
			maxTokens: 1_000_000,
			percentage: 2.54,
		});
	});

	it("prefers last message iteration over cumulative usage", () => {
		const meta = buildClaudeStoredMeta(
			{
				type: "result",
				usage: {
					input_tokens: 340,
					cache_creation_input_tokens: 75_098,
					cache_read_input_tokens: 1_008_704,
					output_tokens: 18_132,
					iterations: [
						{
							type: "message",
							input_tokens: 1,
							cache_creation_input_tokens: 2_468,
							cache_read_input_tokens: 72_630,
							output_tokens: 3_056,
						},
					],
				},
				modelUsage: {
					[CLAUDE_MODEL]: { contextWindow: 1_000_000 },
				},
			},
			CLAUDE_MODEL,
		);
		expect(meta).toEqual({
			modelId: CLAUDE_MODEL,
			usedTokens: 78_155,
			maxTokens: 1_000_000,
			percentage: 7.82,
		});
	});

	it("accepts legacy top-level iterations", () => {
		const meta = buildClaudeStoredMeta(
			{
				type: "result",
				usage: {
					input_tokens: 340,
					cache_creation_input_tokens: 75_098,
					cache_read_input_tokens: 1_008_704,
					output_tokens: 18_132,
				},
				iterations: [
					{
						type: "message",
						input_tokens: 1,
						cache_creation_input_tokens: 2_468,
						cache_read_input_tokens: 72_630,
						output_tokens: 3_056,
					},
				],
				modelUsage: {
					[CLAUDE_MODEL]: { contextWindow: 1_000_000 },
				},
			},
			CLAUDE_MODEL,
		);
		expect(meta).toEqual({
			modelId: CLAUDE_MODEL,
			usedTokens: 78_155,
			maxTokens: 1_000_000,
			percentage: 7.82,
		});
	});

	it("uses the LAST entry when iterations has multiple message entries", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: { input_tokens: 999_999 },
				iterations: [
					{ type: "message", input_tokens: 10_000, output_tokens: 0 },
					{ type: "message", input_tokens: 20_000, output_tokens: 0 },
					{ type: "message", input_tokens: 42_000, output_tokens: 0 },
				],
				modelUsage: { foo: { contextWindow: 1_000_000 } },
			},
			"",
		);
		expect(meta?.usedTokens).toBe(42_000);
	});

	it("skips a trailing compaction iteration to find the last message", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: { input_tokens: 999_999 },
				iterations: [
					{ type: "message", input_tokens: 50_000, output_tokens: 0 },
					{ type: "compaction", input_tokens: 8_000 },
				],
				modelUsage: { foo: { contextWindow: 1_000_000 } },
			},
			"",
		);
		expect(meta?.usedTokens).toBe(50_000);
	});

	it("falls back to usage when iterations is an empty array", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: { input_tokens: 5_000, output_tokens: 100 },
				iterations: [],
				modelUsage: { foo: { contextWindow: 200_000 } },
			},
			"",
		);
		expect(meta?.usedTokens).toBe(5_100);
	});

	it("uses the modelId-matched contextWindow across multiple modelUsage entries", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: { input_tokens: 100, output_tokens: 50 },
				modelUsage: {
					"claude-sonnet-4-5": { contextWindow: 200_000 },
					[CLAUDE_MODEL]: { contextWindow: 1_000_000 },
				},
			},
			"claude-sonnet-4-5",
		);
		expect(meta?.maxTokens).toBe(200_000);
	});

	it("falls back to matching the top-level usage tokens when modelId is an alias", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: {
					input_tokens: 10,
					cache_creation_input_tokens: 13_412,
					cache_read_input_tokens: 114_791,
					output_tokens: 954,
				},
				modelUsage: {
					"claude-haiku-4-5-20251001": {
						inputTokens: 378,
						outputTokens: 15,
						cacheCreationInputTokens: 0,
						cacheReadInputTokens: 0,
						contextWindow: 200_000,
					},
					[CLAUDE_MODEL]: {
						inputTokens: 10,
						outputTokens: 954,
						cacheCreationInputTokens: 13_412,
						cacheReadInputTokens: 114_791,
						contextWindow: 1_000_000,
					},
				},
			},
			"opus",
		);
		expect(meta?.maxTokens).toBe(1_000_000);
		expect(meta?.usedTokens).toBe(129_167);
	});

	it("returns null for ambiguous multi-model usage without a match", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: { input_tokens: 100, output_tokens: 50 },
				modelUsage: {
					"haiku-4-5": {
						inputTokens: 1,
						outputTokens: 2,
						contextWindow: 200_000,
					},
					[CLAUDE_MODEL]: {
						inputTokens: 3,
						outputTokens: 4,
						contextWindow: 1_000_000,
					},
				},
			},
			"alias-with-no-direct-entry",
		);
		expect(meta).toBeNull();
	});

	it("clamps used at maxTokens when sum exceeds the window", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: { input_tokens: 1_200_000, output_tokens: 0 },
				modelUsage: { foo: { contextWindow: 1_000_000 } },
			},
			CLAUDE_MODEL,
		);
		expect(meta?.usedTokens).toBe(1_000_000);
		expect(meta?.percentage).toBe(100);
	});

	it("returns null when usage is missing", () => {
		expect(buildClaudeStoredMeta({ modelUsage: {} }, CLAUDE_MODEL)).toBeNull();
	});

	it("returns null when modelUsage is missing", () => {
		expect(
			buildClaudeStoredMeta(
				{ usage: { input_tokens: 10, output_tokens: 1 } },
				CLAUDE_MODEL,
			),
		).toBeNull();
	});

	it("returns null on an empty turn (zero tokens)", () => {
		expect(
			buildClaudeStoredMeta(
				{
					usage: { input_tokens: 0, output_tokens: 0 },
					modelUsage: { foo: { contextWindow: 1_000_000 } },
				},
				CLAUDE_MODEL,
			),
		).toBeNull();
	});

	it("accepts empty-string modelId without crashing", () => {
		const meta = buildClaudeStoredMeta(
			{
				usage: { input_tokens: 1000, output_tokens: 10 },
				modelUsage: { foo: { contextWindow: 1_000_000 } },
			},
			"",
		);
		expect(meta?.modelId).toBe("");
		expect(meta?.usedTokens).toBe(1010);
	});

	it("accepts error-result turns", () => {
		const meta = buildClaudeStoredMeta(
			{
				type: "result",
				subtype: "error_max_turns",
				is_error: true,
				usage: { input_tokens: 5000, output_tokens: 100 },
				modelUsage: { "claude-sonnet-4-5": { contextWindow: 200_000 } },
			},
			"claude-sonnet-4-5",
		);
		expect(meta).toEqual({
			modelId: "claude-sonnet-4-5",
			usedTokens: 5100,
			maxTokens: 200_000,
			percentage: 2.55,
		});
	});
});

describe("buildClaudeRichMeta", () => {
	it("maps SDK response + stamps modelId, drops Free space + color", () => {
		const rich = buildClaudeRichMeta(
			{
				totalTokens: 1500,
				maxTokens: 200_000,
				percentage: 0.75,
				isAutoCompactEnabled: true,
				categories: [
					{ name: "Messages", tokens: 800, color: "#f00" },
					{ name: "System tools", tokens: 700, color: "#0f0" },
					{ name: "Free space", tokens: 198_500, color: "#fff" },
				],
			},
			CLAUDE_MODEL,
		);
		expect(rich).toEqual({
			modelId: CLAUDE_MODEL,
			usedTokens: 1500,
			maxTokens: 200_000,
			percentage: 0.75,
			isAutoCompactEnabled: true,
			categories: [
				{ name: "Messages", tokens: 800 },
				{ name: "System tools", tokens: 700 },
			],
		});
	});

	it("tolerates a missing categories array", () => {
		const rich = buildClaudeRichMeta(
			{
				totalTokens: 100,
				maxTokens: 1000,
				percentage: 10,
			},
			CLAUDE_MODEL,
		);
		expect(rich.categories).toEqual([]);
		expect(rich.isAutoCompactEnabled).toBe(false);
	});
});

describe("buildCodexStoredMeta", () => {
	it("uses last.totalTokens as the numerator + stamps modelId", () => {
		const meta = buildCodexStoredMeta(
			{
				modelContextWindow: 400_000,
				last: { totalTokens: 12_000 },
				total: { totalTokens: 50_000 },
			},
			CODEX_MODEL,
		);
		expect(meta).toEqual({
			modelId: CODEX_MODEL,
			usedTokens: 12_000,
			maxTokens: 400_000,
			percentage: 3,
		});
	});

	it("falls back to total.totalTokens when last is absent", () => {
		const meta = buildCodexStoredMeta(
			{
				modelContextWindow: 400_000,
				total: { totalTokens: 8000 },
			},
			CODEX_MODEL,
		);
		expect(meta?.usedTokens).toBe(8000);
	});

	it("clamps used at maxTokens when it exceeds the window", () => {
		const meta = buildCodexStoredMeta(
			{
				modelContextWindow: 200_000,
				last: { totalTokens: 250_000 },
			},
			CODEX_MODEL,
		);
		expect(meta?.usedTokens).toBe(200_000);
		expect(meta?.percentage).toBe(100);
	});

	it("returns null when there is nothing meaningful to persist", () => {
		expect(
			buildCodexStoredMeta({ last: { totalTokens: 0 } }, CODEX_MODEL),
		).toBeNull();
	});

	it("stamps empty-string modelId without crashing", () => {
		const meta = buildCodexStoredMeta(
			{ modelContextWindow: 100_000, last: { totalTokens: 1000 } },
			"",
		);
		expect(meta?.modelId).toBe("");
	});
});
