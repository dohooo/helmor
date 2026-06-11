import { describe, expect, test } from "bun:test";
import {
	assemblePlanText,
	buildContextUsageMeta,
	buildImageParts,
	buildPermissionRules,
	buildPromptParts,
	capturePlanPart,
	extractTitleText,
	flattenOpencodeModels,
	mapQuestionAnswers,
	newPlanCapture,
	notePlanMessage,
	parseModelSlug,
	parseSlashCommand,
	planMessageId,
	reapplySessionPermission,
	resetPlanCapture,
} from "./opencode-session-manager.js";

type ReapplyClient = Parameters<typeof reapplySessionPermission>[0];

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
	test("always grants a single allow-all rule (plan read-only rides the agent)", () => {
		expect(buildPermissionRules()).toEqual([
			{ permission: "*", pattern: "*", action: "allow" },
		]);
	});
});

describe("reapplySessionPermission", () => {
	test("reasserts allow-all on a resumed session (old session may hold ask rules)", async () => {
		const calls: unknown[] = [];
		const client = {
			session: {
				update: async (params: unknown) => {
					calls.push(params);
				},
			},
		} as unknown as ReapplyClient;

		await reapplySessionPermission(client, "ses_old", "/work/dir");

		expect(calls).toEqual([
			{
				sessionID: "ses_old",
				directory: "/work/dir",
				permission: [{ permission: "*", pattern: "*", action: "allow" }],
			},
		]);
	});

	test("swallows update failures — a stale-permission resume must not block the turn", async () => {
		const client = {
			session: {
				update: async () => {
					throw new Error("session.update boom");
				},
			},
		} as unknown as ReapplyClient;

		// Must resolve, not reject.
		await expect(
			reapplySessionPermission(client, "ses_x", "/w"),
		).resolves.toBeUndefined();
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

describe("plan capture (opencode plan mode → plan-review card)", () => {
	const textUpdated = (messageID: string, id: string, text: string) => ({
		type: "message.part.updated",
		properties: { part: { type: "text", id, messageID, text } },
	});

	test("captures assistant text snapshots, latest snapshot wins per part", () => {
		const cap = newPlanCapture();
		notePlanMessage(cap, { role: "assistant", id: "m1" });
		// Streamed snapshots for the same part — final one is authoritative.
		expect(capturePlanPart(cap, textUpdated("m1", "p1", "## Pla"))).toBe(true);
		expect(
			capturePlanPart(cap, textUpdated("m1", "p1", "## Plan\n- step")),
		).toBe(true);
		expect(assemblePlanText(cap)).toBe("## Plan\n- step");
		expect(planMessageId(cap)).toBe("m1");
	});

	test("captures text that arrives BEFORE its role event (the race)", () => {
		const cap = newPlanCapture();
		// opencode emits the text part first; role (message.updated) lands later.
		expect(capturePlanPart(cap, textUpdated("m1", "p1", "the plan"))).toBe(
			true,
		);
		// Before the role is known, the split is undecided → nothing assembled yet.
		expect(assemblePlanText(cap)).toBe("");
		// Role arrives at/by idle → the captured text is now attributed correctly.
		notePlanMessage(cap, { role: "assistant", id: "m1" });
		expect(assemblePlanText(cap)).toBe("the plan");
		expect(planMessageId(cap)).toBe("m1");
	});

	test("joins multiple text parts in arrival order", () => {
		const cap = newPlanCapture();
		notePlanMessage(cap, { role: "assistant", id: "m1" });
		capturePlanPart(cap, textUpdated("m1", "p1", "intro"));
		capturePlanPart(cap, textUpdated("m1", "p2", "the plan"));
		expect(assemblePlanText(cap)).toBe("intro\n\nthe plan");
	});

	test("drops all deltas (suppressed so partial prose never leaks)", () => {
		const cap = newPlanCapture();
		expect(
			capturePlanPart(cap, {
				type: "message.part.delta",
				properties: { partID: "p1", field: "text", delta: "abc" },
			}),
		).toBe(true);
		// Delta content is NOT captured — only full-text snapshots are.
		expect(assemblePlanText(cap)).toBe("");
	});

	test("suppresses the user-prompt echo but excludes it from the plan", () => {
		const cap = newPlanCapture();
		notePlanMessage(cap, { role: "user", id: "u1" });
		notePlanMessage(cap, { role: "assistant", id: "m1" });
		// User echo text is suppressed (true) — the accumulator drops it anyway —
		// but it must NOT end up in the plan.
		expect(capturePlanPart(cap, textUpdated("u1", "pu", "my request"))).toBe(
			true,
		);
		expect(capturePlanPart(cap, textUpdated("m1", "p1", "the plan"))).toBe(
			true,
		);
		expect(assemblePlanText(cap)).toBe("the plan");
		expect(planMessageId(cap)).toBe("m1");
	});

	test("passes through non-text parts and lifecycle events", () => {
		const cap = newPlanCapture();
		notePlanMessage(cap, { role: "assistant", id: "m1" });
		expect(
			capturePlanPart(cap, {
				type: "message.part.updated",
				properties: { part: { type: "tool", id: "t1", messageID: "m1" } },
			}),
		).toBe(false);
		expect(
			capturePlanPart(cap, {
				type: "message.part.updated",
				properties: { part: { type: "reasoning", id: "r1", messageID: "m1" } },
			}),
		).toBe(false);
		expect(capturePlanPart(cap, { type: "session.idle" })).toBe(false);
	});

	test("notePlanMessage records both user and assistant roles", () => {
		const cap = newPlanCapture();
		notePlanMessage(cap, { role: "user", id: "u1" });
		notePlanMessage(cap, { role: "assistant", id: "m1" });
		notePlanMessage(cap, undefined);
		expect(cap.roleByMessageId.get("u1")).toBe("user");
		expect(cap.roleByMessageId.get("m1")).toBe("assistant");
	});

	test("resetPlanCapture clears state between turns", () => {
		const cap = newPlanCapture();
		notePlanMessage(cap, { role: "assistant", id: "m1" });
		capturePlanPart(cap, textUpdated("m1", "p1", "old plan"));
		resetPlanCapture(cap);
		expect(assemblePlanText(cap)).toBe("");
		expect(planMessageId(cap)).toBeNull();
		expect(cap.roleByMessageId.size).toBe(0);
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
