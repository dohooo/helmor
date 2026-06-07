import { describe, expect, test } from "bun:test";
import {
	buildContextUsageMeta,
	buildImageParts,
	buildPermissionRules,
	buildPromptParts,
	extractTitleText,
	flattenOpencodeModels,
	mapQuestionAnswers,
	parseModelSlug,
	parseSlashCommand,
} from "./opencode-session-manager.js";

describe("parseSlashCommand", () => {
	test("bare command → name + empty args", () => {
		expect(parseSlashCommand("/init")).toEqual({
			command: "init",
			arguments: "",
		});
	});

	test("command with arguments", () => {
		expect(parseSlashCommand("/review uncommitted changes")).toEqual({
			command: "review",
			arguments: "uncommitted changes",
		});
	});

	test("hyphenated/underscored skill names", () => {
		expect(parseSlashCommand("/lark-task do thing")).toEqual({
			command: "lark-task",
			arguments: "do thing",
		});
	});

	test("plain prompts and stray slashes → null (sent as normal prompt)", () => {
		expect(parseSlashCommand("hello world")).toBeNull();
		expect(parseSlashCommand("/")).toBeNull();
		expect(parseSlashCommand("/ x")).toBeNull();
		expect(parseSlashCommand("a/b")).toBeNull();
		expect(parseSlashCommand("look at src/index.ts")).toBeNull();
	});
});

describe("buildImageParts", () => {
	test("maps image paths to file:// file parts", () => {
		const parts = buildImageParts(["/tmp/a.png"]);
		expect(parts).toEqual([
			{
				type: "file",
				mime: "image/png",
				filename: "a.png",
				url: "file:///tmp/a.png",
			},
		]);
	});

	test("empty → no parts (command text comes from the template)", () => {
		expect(buildImageParts([])).toEqual([]);
	});
});

describe("buildPromptParts", () => {
	test("text only → single text part", () => {
		expect(buildPromptParts("hello", [])).toEqual([
			{ type: "text", text: "hello" },
		]);
	});

	test("text + images → text part then file parts with mime + file:// url", () => {
		const parts = buildPromptParts("look", ["/tmp/a.png", "/tmp/b.jpg"]);
		expect(parts[0]).toEqual({ type: "text", text: "look" });
		expect(parts[1]).toMatchObject({
			type: "file",
			mime: "image/png",
			filename: "a.png",
		});
		expect((parts[1] as { url: string }).url).toBe("file:///tmp/a.png");
		expect(parts[2]).toMatchObject({
			type: "file",
			mime: "image/jpeg",
			filename: "b.jpg",
		});
	});

	test("empty prompt with image → only the file part", () => {
		const parts = buildPromptParts("  ", ["/tmp/x.webp"]);
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ type: "file", mime: "image/webp" });
	});
});

describe("parseModelSlug", () => {
	test("splits provider/model on the first slash", () => {
		expect(parseModelSlug("anthropic/claude-opus-4-5")).toEqual({
			providerID: "anthropic",
			modelID: "claude-opus-4-5",
		});
	});

	test("rejects ids without a usable slash", () => {
		expect(parseModelSlug("opus")).toBeUndefined();
		expect(parseModelSlug("/x")).toBeUndefined();
		expect(parseModelSlug("x/")).toBeUndefined();
		expect(parseModelSlug(undefined)).toBeUndefined();
	});
});

describe("flattenOpencodeModels", () => {
	const data = {
		connected: ["opencode", "hundun"],
		all: [
			{
				id: "hundun",
				name: "DeepSeek (Hundun)",
				models: {
					"deepseek-v4-pro": { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
				},
			},
			{
				id: "opencode",
				name: "OpenCode Zen",
				models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } },
			},
			// NOT connected → excluded.
			{
				id: "openai",
				name: "OpenAI",
				models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" } },
			},
		],
	};

	test("keeps only connected providers, slugs + subProvider labels, sorted", () => {
		const models = flattenOpencodeModels(data);
		expect(models).toEqual([
			{
				id: "hundun/deepseek-v4-pro",
				label: "DeepSeek (Hundun) · DeepSeek V4 Pro",
				cliModel: "hundun/deepseek-v4-pro",
			},
			{
				id: "opencode/big-pickle",
				label: "OpenCode Zen · Big Pickle",
				cliModel: "opencode/big-pickle",
			},
		]);
	});

	test("returns empty when nothing connected or data missing", () => {
		expect(flattenOpencodeModels({ all: data.all, connected: [] })).toEqual([]);
		expect(flattenOpencodeModels(undefined)).toEqual([]);
	});

	test("surfaces a model's variants keys as effortLevels (in order); omits when none", () => {
		const withVariants = {
			connected: ["hundun"],
			all: [
				{
					id: "hundun",
					name: "DeepSeek (Hundun)",
					models: {
						"deepseek-v4-pro": {
							id: "deepseek-v4-pro",
							name: "DeepSeek V4 Pro",
							variants: { low: {}, medium: {}, high: {}, max: {} },
						},
						chat: { id: "chat", name: "Chat" },
					},
				},
			],
		};
		const models = flattenOpencodeModels(withVariants);
		const v4 = models.find((m) => m.id === "hundun/deepseek-v4-pro");
		const chat = models.find((m) => m.id === "hundun/chat");
		expect(v4?.effortLevels).toEqual(["low", "medium", "high", "max"]);
		expect(chat?.effortLevels).toBeUndefined();
	});
});

describe("buildPermissionRules", () => {
	test("bypass-style modes grant a single allow-all rule", () => {
		for (const mode of ["bypassPermissions", "dontAsk", "auto"]) {
			expect(buildPermissionRules(mode)).toEqual([
				{ permission: "*", pattern: "*", action: "allow" },
			]);
		}
	});

	test("default mode asks for everything but pre-allows questions", () => {
		expect(buildPermissionRules(undefined)).toEqual([
			{ permission: "*", pattern: "*", action: "ask" },
			{ permission: "question", pattern: "*", action: "allow" },
		]);
		expect(buildPermissionRules("default")).toEqual(
			buildPermissionRules(undefined),
		);
	});

	test("acceptEdits adds an edit allow on top of ask-all", () => {
		const rules = buildPermissionRules("acceptEdits");
		expect(rules).toHaveLength(3);
		// Last-match-wins: the edit allow must come after the catch-all ask.
		expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "ask" });
		expect(rules[2]).toEqual({
			permission: "edit",
			pattern: "*",
			action: "allow",
		});
	});
});

describe("extractTitleText", () => {
	test("joins text parts with newlines, ignoring non-text parts", () => {
		const parts = [
			{ type: "text", text: "My Title" },
			{ type: "tool", tool: "bash" },
			{ type: "reasoning", text: "ignored" },
			{ type: "text", text: "branch/name" },
		];
		expect(extractTitleText(parts)).toBe("My Title\nbranch/name");
	});

	test("trims surrounding whitespace", () => {
		expect(extractTitleText([{ type: "text", text: "  spaced  " }])).toBe(
			"spaced",
		);
	});

	test("returns empty string for non-arrays or no text parts", () => {
		expect(extractTitleText("nope")).toBe("");
		expect(extractTitleText(undefined)).toBe("");
		expect(extractTitleText([{ type: "reasoning", text: "x" }])).toBe("");
	});
});

describe("mapQuestionAnswers", () => {
	const questions = [{ question: "Pick one" }, { question: "Pick many" }];

	test("maps comma-joined single answers to per-question string arrays", () => {
		const content = { answers: { "Pick one": "A", "Pick many": "B, C" } };
		expect(mapQuestionAnswers(questions, content)).toEqual([["A"], ["B", "C"]]);
	});

	test("accepts array answers and fills gaps with empty arrays", () => {
		const content = { answers: { "Pick many": ["X", "Y"] } };
		expect(mapQuestionAnswers(questions, content)).toEqual([[], ["X", "Y"]]);
	});

	test("returns empty arrays when content is missing", () => {
		expect(mapQuestionAnswers(questions, undefined)).toEqual([[], []]);
	});
});

describe("buildContextUsageMeta", () => {
	const parts = {
		input: 10_000,
		output: 3_000,
		reasoning: 0,
		cacheRead: 500,
		cacheWrite: 0,
	};

	test("derives percentage and drops zero-token categories", () => {
		const meta = JSON.parse(
			buildContextUsageMeta({
				modelId: "deepseek/deepseek-chat",
				usedTokens: 13_500,
				maxTokens: 200_000,
				cost: 0.0123,
				parts,
			}),
		);
		expect(meta).toEqual({
			modelId: "deepseek/deepseek-chat",
			usedTokens: 13_500,
			maxTokens: 200_000,
			percentage: 7,
			cost: 0.0123,
			categories: [
				{ name: "Input", tokens: 10_000 },
				{ name: "Output", tokens: 3_000 },
				{ name: "Cache read", tokens: 500 },
			],
		});
	});

	test("percentage is 0 when the context limit is unknown (custom provider)", () => {
		const meta = JSON.parse(
			buildContextUsageMeta({
				modelId: "hundun/gpt-5.5",
				usedTokens: 13_500,
				maxTokens: 0,
				cost: 0,
				parts,
			}),
		);
		expect(meta.percentage).toBe(0);
		expect(meta.maxTokens).toBe(0);
		expect(meta.categories).toHaveLength(3);
	});
});
