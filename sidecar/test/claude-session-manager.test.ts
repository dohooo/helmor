/**
 * ClaudeSessionManager integration test.
 *
 * Feeds a real captured Claude stream fixture through a mocked
 * `@anthropic-ai/claude-agent-sdk` and asserts on the resulting emitter
 * events. Fixtures live under `src-tauri/tests/fixtures/streams/claude/`
 * (shared with Tauri's pipeline tests); we strip the sidecar-added
 * `id` field so what we replay matches raw SDK output.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSidecarEmitter, type SidecarEmitter } from "../src/emitter.js";

process.env.HELMOR_LOG_DIR = resolve(tmpdir(), "helmor-sidecar-test-logs");

// ---------------------------------------------------------------------------
// Mock the Claude Agent SDK BEFORE importing anything that uses it.
// A closure variable lets each test supply its own async iterator.
// ---------------------------------------------------------------------------

type MockQueryResult = AsyncIterable<unknown> & {
	supportedCommands?: () => Promise<
		Array<{
			name: string;
			description: string;
			argumentHint?: string;
		}>
	>;
	getContextUsage?: () => Promise<unknown>;
	close?: () => void;
};

type MockHookFn = (
	input: { hook_event_name: string; tool_name: string },
	toolUseID: string,
) => Promise<{
	hookSpecificOutput?: Record<string, unknown>;
}>;

type MockQueryImpl = (options: {
	prompt?: unknown;
	options?: {
		abortController?: AbortController;
		onElicitation?: (
			request: {
				serverName: string;
				message: string;
				mode?: "form" | "url";
				url?: string;
				elicitationId?: string;
				requestedSchema?: Record<string, unknown>;
			},
			options: { signal: AbortSignal },
		) => Promise<{ action: string; content?: Record<string, unknown> }>;
		hooks?: {
			PreToolUse?: Array<{ hooks: MockHookFn[] }>;
		};
	};
}) => MockQueryResult;

let mockQueryImpl: MockQueryImpl = () => emptyAsyncIterable();
let lastQueryArgs: unknown = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	query: (options: unknown) => {
		lastQueryArgs = options;
		return mockQueryImpl(options as Parameters<MockQueryImpl>[0]);
	},
}));

// Dynamic import AFTER the mock is registered so the manager picks up the
// mocked `query`. A static top-level import of the manager would resolve
// the real SDK before the mock is applied.
const { ClaudeSessionManager } = await import(
	"../src/claude-session-manager.js"
);

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

// Provider-scoped fixture root — stream fixtures are organized by
// provider under `src-tauri/tests/fixtures/streams/<provider>/`.
const CLAUDE_FIXTURE_ROOT = resolve(
	import.meta.dir,
	"../../src-tauri/tests/fixtures/streams/claude",
);

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(resolve(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempRoots.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface FixtureEvent {
	readonly [key: string]: unknown;
}

function loadClaudeFixture(fixtureName: string): FixtureEvent[] {
	const raw = readFileSync(resolve(CLAUDE_FIXTURE_ROOT, fixtureName), "utf-8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.map((obj) => {
			// Strip the sidecar-added `id` field (our capture infra added it).
			// The rest (`event`, `session_id`, `uuid`, `parent_tool_use_id`,
			// `type`, `subtype`, ...) is the raw SDK message shape.
			const { id: _discard, ...rest } = obj;
			return rest;
		});
}

function expectedSendMessageEvents(
	sdkMessages: readonly FixtureEvent[],
): readonly FixtureEvent[] {
	const expected: FixtureEvent[] = [];

	for (const message of sdkMessages) {
		expected.push(message);
		if (
			message.type === "result" &&
			!("deferred_tool_use" in message) &&
			message.is_error !== true
		) {
			break;
		}
	}

	return expected;
}

async function* asyncIterableFrom<T>(items: readonly T[]): AsyncGenerator<T> {
	for (const item of items) yield item;
}

function emptyAsyncIterable(): AsyncIterable<unknown> {
	return asyncIterableFrom<unknown>([]);
}

function makeMockQuery({
	stream = [],
	supportedCommands,
	close,
}: {
	stream?: readonly unknown[];
	supportedCommands?: MockQueryResult["supportedCommands"];
	close?: () => void;
} = {}): MockQueryResult {
	const iterable = asyncIterableFrom(stream);
	return {
		supportedCommands,
		close: close ?? (() => undefined),
		[Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
	};
}

async function waitForCondition(
	predicate: () => boolean,
	label: string,
	timeoutMs = 250,
): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out waiting for ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeSessionManager.sendMessage", () => {
	let captured: Array<Record<string, unknown>>;
	let emitter: SidecarEmitter;
	let manager: InstanceType<typeof ClaudeSessionManager>;

	beforeEach(() => {
		captured = [];
		lastQueryArgs = null;
		emitter = createSidecarEmitter((event) => {
			captured.push(event as Record<string, unknown>);
		});
		manager = new ClaudeSessionManager();
	});

	test("forwards every SDK message as a passthrough event and ends with 'end'", async () => {
		const sdkMessages = loadClaudeFixture("thinking-text.jsonl");
		expect(sdkMessages.length).toBeGreaterThan(0);

		mockQueryImpl = () => asyncIterableFrom(sdkMessages);

		await manager.sendMessage(
			"REQ-1",
			{
				sessionId: "helmor-sess-1",
				prompt: "what is this code",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		// One passthrough per SDK message, plus an optional
		// `contextUsageUpdated` (emitted when the terminal result carries
		// usage data — most fixtures do), plus a trailing `end`.
		const withoutCtxUsage = captured.filter(
			(e) => e.type !== "contextUsageUpdated",
		);
		expect(withoutCtxUsage).toHaveLength(sdkMessages.length + 1);

		const last = captured[captured.length - 1];
		expect(last).toEqual({ id: "REQ-1", type: "end" });
	});

	test("emits contextUsageUpdated from the terminal result's usage + modelUsage, stamping the requested modelId", async () => {
		const sdkMessages = [
			{
				type: "result",
				subtype: "success",
				is_error: false,
				session_id: "sdk-sess-1",
				usage: {
					input_tokens: 6,
					cache_creation_input_tokens: 12_267,
					cache_read_input_tokens: 13_101,
					output_tokens: 10,
				},
				modelUsage: {
					"claude-opus-4-7[1m]": { contextWindow: 1_000_000 },
				},
			},
		];
		mockQueryImpl = () => asyncIterableFrom(sdkMessages);

		await manager.sendMessage(
			"REQ-ctx",
			{
				sessionId: "helmor-sess-ctx",
				prompt: "hi",
				model: "claude-opus-4-7[1m]",
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		const ctxUsage = captured.find((e) => e.type === "contextUsageUpdated");
		expect(ctxUsage).toBeDefined();
		expect(ctxUsage?.id).toBe("REQ-ctx");
		expect(ctxUsage?.sessionId).toBe("helmor-sess-ctx");
		const meta = JSON.parse(ctxUsage?.meta as string);
		expect(meta).toEqual({
			modelId: "claude-opus-4-7[1m]",
			usedTokens: 25_384,
			maxTokens: 1_000_000,
			// 25384 / 1_000_000 * 100 rounded to 2 decimals.
			percentage: 2.54,
		});
	});

	test("getContextUsage fast path reuses the live Query and returns rich meta", async () => {
		// Feed a terminal result so sendMessage registers the session into
		// `manager.sessions` before we call getContextUsage.
		const terminalResult = {
			type: "result",
			subtype: "success",
			is_error: false,
			session_id: "sdk-sess-rich",
			usage: { input_tokens: 100, output_tokens: 10 },
			modelUsage: { "claude-opus-4-7": { contextWindow: 200_000 } },
		};
		// Use a never-ending stream so the session stays live — we'll call
		// getContextUsage before the stream completes.
		let resolveStream: (v: unknown) => void = () => {};
		const streamPromise = new Promise((resolve) => {
			resolveStream = resolve;
		});
		const liveIterable: AsyncIterable<unknown> = {
			[Symbol.asyncIterator]: () => ({
				async next() {
					await streamPromise;
					return { value: terminalResult, done: false };
				},
			}),
		};

		let getContextUsageCalls = 0;
		mockQueryImpl = () =>
			Object.assign(liveIterable, {
				async getContextUsage() {
					getContextUsageCalls += 1;
					return {
						totalTokens: 1500,
						maxTokens: 200_000,
						percentage: 0.75,
						isAutoCompactEnabled: true,
						categories: [
							{ name: "Messages", tokens: 800, color: "#000" },
							{ name: "Free space", tokens: 198_500, color: "#fff" },
						],
					};
				},
				close: () => undefined,
			});

		// Kick off sendMessage so `manager.sessions` has an entry;
		// don't await — stream is intentionally never-ending.
		void manager.sendMessage(
			"REQ-live",
			{
				sessionId: "helmor-live",
				prompt: "hi",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		// Wait a microtask so the manager registers the live session
		// before we hit the fast path.
		await waitForCondition(
			// biome-ignore lint/suspicious/noExplicitAny: private for test
			() => (manager as any).sessions.size > 0,
			"session registered",
		);

		const json = await manager.getContextUsage({
			helmorSessionId: "helmor-live",
			providerSessionId: null,
			model: "claude-opus-4-7",
			cwd: undefined,
		});
		expect(getContextUsageCalls).toBe(1);
		const meta = JSON.parse(json);
		expect(meta).toEqual({
			modelId: "claude-opus-4-7",
			usedTokens: 1500,
			maxTokens: 200_000,
			percentage: 0.75,
			isAutoCompactEnabled: true,
			// "Free space" filtered out.
			categories: [{ name: "Messages", tokens: 800 }],
		});

		// Let the send-message promise settle so the test tears down cleanly.
		resolveStream(null);
	});

	test("getContextUsage slow path spawns a transient Query + returns rich meta", async () => {
		// No live session for this helmor id — slow path kicks in. The
		// mock query is reused for the transient spawn; `getContextUsage`
		// resolves immediately so no real 30s timer ever fires.
		mockQueryImpl = () =>
			Object.assign(asyncIterableFrom<unknown>([]), {
				async getContextUsage() {
					return {
						totalTokens: 42_000,
						maxTokens: 1_000_000,
						percentage: 4.2,
						isAutoCompactEnabled: false,
						categories: [],
					};
				},
				close: () => undefined,
			});

		const json = await manager.getContextUsage({
			helmorSessionId: "no-live-session",
			providerSessionId: "provider-xyz",
			model: "claude-opus-4-7",
			cwd: undefined,
		});

		const meta = JSON.parse(json);
		expect(meta.modelId).toBe("claude-opus-4-7");
		expect(meta.usedTokens).toBe(42_000);
		expect(meta.maxTokens).toBe(1_000_000);
		// Assert the transient query was configured with resume + model so
		// the SDK loads the correct window size (we check the last recorded
		// query() args).
		const args = lastQueryArgs as {
			options?: { resume?: string; model?: string };
		};
		expect(args.options?.resume).toBe("provider-xyz");
		expect(args.options?.model).toBe("claude-opus-4-7");
	});

	test("emits contextUsageUpdated for an error-result turn too (same usage shape)", async () => {
		// Regression: the previous gate filtered out error results via
		// `isTerminalSuccessResult`, so aborted-by-limit turns lost their
		// usage update even though the consumed context was real.
		const sdkMessages = [
			{
				type: "result",
				subtype: "error_max_turns",
				is_error: true,
				session_id: "sdk-sess-err",
				usage: {
					input_tokens: 5000,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					output_tokens: 100,
				},
				modelUsage: {
					"claude-sonnet-4-5": { contextWindow: 200_000 },
				},
			},
		];
		mockQueryImpl = () => asyncIterableFrom(sdkMessages);

		await manager.sendMessage(
			"REQ-err",
			{
				sessionId: "helmor-sess-err",
				prompt: "hi",
				model: "claude-sonnet-4-5",
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		const ctxUsage = captured.find((e) => e.type === "contextUsageUpdated");
		expect(ctxUsage).toBeDefined();
		const meta = JSON.parse(ctxUsage?.meta as string);
		expect(meta.modelId).toBe("claude-sonnet-4-5");
		expect(meta.usedTokens).toBe(5100);
		expect(meta.maxTokens).toBe(200_000);
	});

	test("supportsFastMode comes from the hardcoded catalog", async () => {
		const models = await manager.listModels();
		const bySupports = Object.fromEntries(
			models.map((m) => [m.id, m.supportsFastMode]),
		);

		expect(bySupports.default).toBeUndefined();
		expect(bySupports.sonnet).toBeUndefined();
		expect(bySupports["claude-opus-4-6[1m]"]).toBe(true);
	});

	test("ignores fastMode for models not in the hardcoded catalog", async () => {
		mockQueryImpl = () => makeMockQuery();

		await manager.sendMessage(
			"REQ-fast-sonnet",
			{
				sessionId: "helmor-sess-fast-sonnet",
				prompt: "test",
				model: "claude-sonnet-4-7",
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: true,
				images: [],
			},
			emitter,
		);

		const args = lastQueryArgs as {
			options?: { settings?: Record<string, unknown> };
		};
		expect(args.options?.settings).toBeUndefined();
	});

	test.each([
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	])("forwards %s effort level to the SDK", async (level) => {
		mockQueryImpl = () => makeMockQuery();

		await manager.sendMessage(
			`REQ-effort-${level}`,
			{
				sessionId: `helmor-sess-effort-${level}`,
				prompt: "test",
				model: "default",
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: level,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		const args = lastQueryArgs as { options?: { effort?: string } };
		expect(args.options?.effort).toBe(level);
	});

	test("drops unknown effort levels instead of forwarding them", async () => {
		mockQueryImpl = () => makeMockQuery();

		await manager.sendMessage(
			"REQ-effort-bogus",
			{
				sessionId: "helmor-sess-effort-bogus",
				prompt: "test",
				model: "default",
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "ultra",
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		const args = lastQueryArgs as { options?: { effort?: string } };
		expect(args.options?.effort).toBeUndefined();
	});

	test("every forwarded event carries our requestId, never an SDK-supplied id", async () => {
		const sdkMessages = loadClaudeFixture("thinking-text.jsonl");
		mockQueryImpl = () => asyncIterableFrom(sdkMessages);

		await manager.sendMessage(
			"UNIQUE-REQ-ID",
			{
				sessionId: "s1",
				prompt: "x",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		for (const event of captured) {
			expect(event.id).toBe("UNIQUE-REQ-ID");
		}
	});

	test("preserves snake_case session_id from SDK messages", async () => {
		const sdkMessages = loadClaudeFixture("thinking-text.jsonl");
		const expectedSessionId = sdkMessages[0]?.session_id;
		expect(typeof expectedSessionId).toBe("string");

		mockQueryImpl = () => asyncIterableFrom(sdkMessages);

		await manager.sendMessage(
			"REQ-2",
			{
				sessionId: "helmor-sess",
				prompt: "x",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		// The passthrough events must carry the SDK's snake_case session_id
		// verbatim — that's how the Rust side learns the provider_session_id
		// to persist. Skip the terminal `end` and any `contextUsageUpdated`
		// (our derived event, which carries a camelCase sessionId instead).
		const passthroughs = captured.filter(
			(e) => e.type !== "end" && e.type !== "contextUsageUpdated",
		);
		for (const event of passthroughs) {
			expect(event.session_id).toBe(expectedSessionId);
		}
	});

	test("emits an `aborted` event when the SDK throws AbortError", async () => {
		const sdkMessages = loadClaudeFixture("thinking-text.jsonl");
		// Yield a few messages then throw an AbortError, simulating
		// `abortController.abort()` mid-stream.
		mockQueryImpl = async function* aborter() {
			yield sdkMessages[0];
			yield sdkMessages[1];
			const err = new Error("The operation was aborted") as Error & {
				name: string;
			};
			err.name = "AbortError";
			throw err;
		};

		await manager.sendMessage(
			"REQ-ABORT",
			{
				sessionId: "s-abort",
				prompt: "x",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		// Exactly two passthroughs + one aborted terminal. No `end` event.
		expect(captured).toHaveLength(3);
		expect(captured[captured.length - 1]).toEqual({
			id: "REQ-ABORT",
			type: "aborted",
			reason: "user_requested",
		});
		expect(captured.some((e) => e.type === "end")).toBe(false);
	});

	test("propagates non-abort errors (manager does NOT swallow them)", async () => {
		mockQueryImpl = async function* boomer() {
			yield { type: "system", subtype: "init", session_id: "s", uuid: "u" };
			throw new Error("upstream 500");
		};

		await expect(
			manager.sendMessage(
				"REQ-ERR",
				{
					sessionId: "s",
					prompt: "x",
					model: undefined,
					cwd: undefined,
					resume: undefined,
					permissionMode: undefined,
					effortLevel: undefined,
					fastMode: undefined,
					images: [],
				},
				emitter,
			),
		).rejects.toThrow("upstream 500");

		// One passthrough got through before the throw. No `end`, no `aborted`.
		expect(captured).toHaveLength(1);
		expect(captured.some((e) => e.type === "end")).toBe(false);
		expect(captured.some((e) => e.type === "aborted")).toBe(false);
	});

	test("forwards only user-linked directories to Claude query options", async () => {
		const userDirA = makeTempDir("helmor-claude-user-a-");
		const userDirB = makeTempDir("helmor-claude-user-b-");

		mockQueryImpl = () => asyncIterableFrom([{ type: "result", result: "ok" }]);

		await manager.sendMessage(
			"REQ-USER-LINKED",
			{
				sessionId: "s-user-linked",
				prompt: "ok",
				model: "opus-1m",
				cwd: undefined,
				resume: undefined,
				permissionMode: "bypassPermissions",
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
				// Include a duplicate to confirm Claude now forwards the
				// caller-provided list directly without extra normalization.
				additionalDirectories: [userDirA, userDirA, userDirB],
			},
			emitter,
		);

		expect(lastQueryArgs).toMatchObject({
			options: {
				additionalDirectories: [userDirA, userDirA, userDirB],
				env: {
					CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
				},
			},
		});
	});

	test("prepends the linked-directories preamble to Claude's first user message", async () => {
		const linkedDirA = makeTempDir("helmor-claude-prompt-a-");
		const linkedDirB = makeTempDir("helmor-claude-prompt-b-");

		mockQueryImpl = () => asyncIterableFrom([{ type: "result", result: "ok" }]);

		await manager.sendMessage(
			"REQ-PREAMBLE",
			{
				sessionId: "s-preamble",
				prompt: "summarize what's in these projects",
				model: "opus-1m",
				cwd: undefined,
				resume: undefined,
				permissionMode: "bypassPermissions",
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
				additionalDirectories: [linkedDirA, linkedDirB],
			},
			emitter,
		);

		const promptSource = (
			lastQueryArgs as {
				prompt?: AsyncIterable<{
					type?: string;
					message?: { role?: string; content?: string };
				}>;
			}
		).prompt;
		const firstMessage = promptSource
			? await promptSource[Symbol.asyncIterator]().next()
			: null;
		const content = firstMessage?.value?.message?.content ?? "";

		expect(content).toContain(linkedDirA);
		expect(content).toContain(linkedDirB);
		expect(content).toContain("summarize what's in these projects");
	});

	test("listSlashCommands forwards additionalDirectories and env", async () => {
		const workspaceDir = makeTempDir("helmor-claude-slash-");
		const linkedDir = makeTempDir("helmor-claude-slash-linked-");

		mockQueryImpl = () =>
			makeMockQuery({
				supportedCommands: async () => [],
			});

		await manager.listSlashCommands({
			cwd: workspaceDir,
			additionalDirectories: [linkedDir],
		});

		expect(lastQueryArgs).toMatchObject({
			options: {
				cwd: workspaceDir,
				additionalDirectories: [linkedDir],
				env: {
					CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
				},
			},
		});
	});

	test("suppresses deferred tool_use passthrough while keeping the deferred control event", async () => {
		mockQueryImpl = async function* withDeferredTool() {
			yield {
				type: "assistant",
				session_id: "sdk-session-1",
				uuid: "assistant-1",
				message: {
					content: [
						{ type: "text", text: "Need a quick decision." },
						{
							type: "tool_use",
							id: "tool-ask-1",
							name: "AskUserQuestion",
							input: {
								questions: [
									{ question: "Which path should we take?", options: [] },
								],
							},
						},
					],
				},
			};
			yield {
				type: "result",
				session_id: "sdk-session-1",
				result: "",
				deferred_tool_use: {
					id: "tool-ask-1",
					name: "AskUserQuestion",
					input: {
						questions: [
							{ question: "Which path should we take?", options: [] },
						],
					},
				},
			};
		};

		await manager.sendMessage(
			"REQ-DEFER",
			{
				sessionId: "helmor-sess-defer",
				prompt: "x",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		expect(captured).toHaveLength(3);
		expect(captured[0]?.type).toBe("assistant");
		expect(
			(
				captured[0]?.message as {
					content?: Array<{ type?: string; name?: string; text?: string }>;
				}
			).content ?? [],
		).toEqual([{ type: "text", text: "Need a quick decision." }]);
		expect(captured[1]).toEqual({
			id: "REQ-DEFER",
			type: "deferredToolUse",
			toolUseId: "tool-ask-1",
			toolName: "AskUserQuestion",
			toolInput: {
				questions: [{ question: "Which path should we take?", options: [] }],
			},
		});
		expect(captured[2]).toEqual({ id: "REQ-DEFER", type: "end" });
	});

	// Regression for AskUserQuestion answer delivery: the Steer commit
	// (1e0d07b) forced every sendMessage through streaming-input mode, which
	// made resume-only streams push a synthetic `{ role: "user", content: "" }`
	// into the SDK. Claude treated that as a new empty user turn and skipped
	// re-invoking the PreToolUse hook, so the user's answer (stored in
	// `deferredToolResponses`) never reached Claude. This test pins the fix:
	// empty prompt => pass `""` (string) to `query()` so the hook re-fires.
	test("empty prompt: query() gets string prompt and PreToolUse hook surfaces the stored resolution", async () => {
		manager.resolveDeferredTool("tool-ask-1", "allow", undefined, {
			questions: [{ question: "Which path should we take?", options: [] }],
			answers: { "Which path should we take?": "Option A" },
		});

		let hookOutput: unknown = null;
		mockQueryImpl = (queryArgs) => {
			const hook = queryArgs.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
			// Simulate the SDK re-invoking PreToolUse for the pending tool_use
			// on resume. The real SDK does this inside its replay loop before
			// executing the deferred tool.
			if (hook) {
				void (async () => {
					hookOutput = await hook(
						{
							hook_event_name: "PreToolUse",
							tool_name: "AskUserQuestion",
						},
						"tool-ask-1",
					);
				})();
			}
			return makeMockQuery({
				stream: [
					{
						type: "result",
						session_id: "sdk-session-resume",
						subtype: "success",
						is_error: false,
						result: "done",
					},
				],
			});
		};

		await manager.sendMessage(
			"REQ-RESUME",
			{
				sessionId: "helmor-sess-defer",
				prompt: "",
				model: undefined,
				cwd: undefined,
				resume: "sdk-session-resume",
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		// Pre-Steer shape: plain empty string. If this ever becomes an object
		// (pushable / iterable), AskUserQuestion answers stop reaching Claude.
		expect(typeof (lastQueryArgs as { prompt?: unknown } | null)?.prompt).toBe(
			"string",
		);
		expect((lastQueryArgs as { prompt: string }).prompt).toBe("");

		await waitForCondition(() => hookOutput !== null, "hook invocation");
		expect(hookOutput).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: {
					questions: [{ question: "Which path should we take?", options: [] }],
					answers: { "Which path should we take?": "Option A" },
				},
			},
		});
	});

	test("stops after a successful result and ignores trailing SDK noise", async () => {
		let tailReached = false;
		let iteratorClosed = false;

		mockQueryImpl = async function* withTrailingNoise() {
			try {
				yield {
					type: "system",
					subtype: "init",
					session_id: "sdk-session-1",
					uuid: "system-1",
				};
				yield {
					type: "assistant",
					session_id: "sdk-session-1",
					uuid: "assistant-1",
					message: {
						content: [{ type: "text", text: "Final answer." }],
					},
				};
				yield {
					type: "result",
					session_id: "sdk-session-1",
					subtype: "success",
					is_error: false,
					result: "Final answer.",
				};

				tailReached = true;
				yield {
					type: "system",
					subtype: "init",
					session_id: "sdk-session-1",
					uuid: "system-2",
				};
				yield {
					type: "assistant",
					session_id: "sdk-session-1",
					uuid: "assistant-2",
					message: {
						content: [{ type: "text", text: "API Error" }],
					},
				};
			} finally {
				iteratorClosed = true;
			}
		};

		await manager.sendMessage(
			"REQ-RESULT-END",
			{
				sessionId: "helmor-sess-result",
				prompt: "x",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		expect(tailReached).toBe(false);
		expect(iteratorClosed).toBe(true);
		expect(captured).toEqual([
			{
				id: "REQ-RESULT-END",
				type: "system",
				subtype: "init",
				session_id: "sdk-session-1",
				uuid: "system-1",
			},
			{
				id: "REQ-RESULT-END",
				type: "assistant",
				session_id: "sdk-session-1",
				uuid: "assistant-1",
				message: {
					content: [{ type: "text", text: "Final answer." }],
				},
			},
			{
				id: "REQ-RESULT-END",
				type: "result",
				session_id: "sdk-session-1",
				subtype: "success",
				is_error: false,
				result: "Final answer.",
			},
			{ id: "REQ-RESULT-END", type: "end" },
		]);
	});
});

describe("ClaudeSessionManager.stopSession", () => {
	test("no-op on unknown sessionId", async () => {
		const manager = new ClaudeSessionManager();
		// Should not throw.
		await manager.stopSession("never-existed");
	});

	test("emits elicitationRequest and resumes when the elicitation is resolved", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const emitter = createSidecarEmitter((event) => {
			captured.push(event as Record<string, unknown>);
		});
		const manager = new ClaudeSessionManager();

		mockQueryImpl = async function* withElicitation(queryArgs) {
			const onElicitation = queryArgs.options?.onElicitation;
			if (!onElicitation) {
				throw new Error("Expected onElicitation hook");
			}

			const result = await onElicitation(
				{
					serverName: "design-server",
					message: "Need more structured input",
					mode: "form",
					elicitationId: "elicitation-1",
					requestedSchema: {
						type: "object",
						properties: {
							name: { type: "string" },
						},
						required: ["name"],
					},
				},
				{ signal: queryArgs.options?.abortController?.signal as AbortSignal },
			);

			yield {
				type: "assistant",
				session_id: "sdk-session-1",
				uuid: "assistant-1",
				message: {
					content: [{ type: "text", text: JSON.stringify(result) }],
				},
			};
			yield {
				type: "result",
				session_id: "sdk-session-1",
				subtype: "success",
				is_error: false,
				result: "done",
			};
		};

		const sendPromise = manager.sendMessage(
			"REQ-ELICIT",
			{
				sessionId: "elicitation-session",
				prompt: "Need structured input",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		await waitForCondition(
			() => captured.some((event) => event.type === "elicitationRequest"),
			"elicitation request event",
		);

		expect(captured[0]).toEqual({
			id: "REQ-ELICIT",
			type: "elicitationRequest",
			serverName: "design-server",
			message: "Need more structured input",
			mode: "form",
			url: undefined,
			elicitationId: "elicitation-1",
			requestedSchema: {
				type: "object",
				properties: {
					name: { type: "string" },
				},
				required: ["name"],
			},
		});

		manager.resolveElicitation("elicitation-1", {
			action: "accept",
			content: { name: "Helmor" },
		});

		await sendPromise;

		expect(captured).toContainEqual({
			id: "REQ-ELICIT",
			type: "assistant",
			session_id: "sdk-session-1",
			uuid: "assistant-1",
			message: {
				content: [
					{
						type: "text",
						text: '{"action":"accept","content":{"name":"Helmor"}}',
					},
				],
			},
		});
		expect(captured[captured.length - 1]).toEqual({
			id: "REQ-ELICIT",
			type: "end",
		});
	});

	test("cancels pending elicitation when the session is stopped", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const emitter = createSidecarEmitter((event) => {
			captured.push(event as Record<string, unknown>);
		});
		const manager = new ClaudeSessionManager();

		mockQueryImpl = async function* withAbortableElicitation(queryArgs) {
			const onElicitation = queryArgs.options?.onElicitation;
			if (!onElicitation) {
				throw new Error("Expected onElicitation hook");
			}

			const result = await onElicitation(
				{
					serverName: "auth-server",
					message: "Finish the external auth flow",
					mode: "url",
					url: "https://example.com/authorize",
					elicitationId: "elicitation-stop-1",
				},
				{ signal: queryArgs.options?.abortController?.signal as AbortSignal },
			);

			yield {
				type: "assistant",
				session_id: "sdk-session-stop",
				uuid: "assistant-stop-1",
				message: {
					content: [{ type: "text", text: JSON.stringify(result) }],
				},
			};
		};

		const sendPromise = manager.sendMessage(
			"REQ-ELICIT-STOP",
			{
				sessionId: "elicitation-stop-session",
				prompt: "Need auth",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: undefined,
				images: [],
			},
			emitter,
		);

		await waitForCondition(
			() => captured.some((event) => event.type === "elicitationRequest"),
			"stop-session elicitation request event",
		);

		await manager.stopSession("elicitation-stop-session");
		await sendPromise;

		expect(captured).toContainEqual({
			id: "REQ-ELICIT-STOP",
			type: "assistant",
			session_id: "sdk-session-stop",
			uuid: "assistant-stop-1",
			message: {
				content: [{ type: "text", text: '{"action":"cancel"}' }],
			},
		});
		expect(captured[captured.length - 1]).toEqual({
			id: "REQ-ELICIT-STOP",
			type: "end",
		});
	});
});

// ---------------------------------------------------------------------------
// Per-fixture diversity guards.
//
// Each captured fixture is a snapshot of real Claude SDK output. These tests
// pin which message types each fixture exercises so that:
//   1. If anyone trims or replaces a fixture, the assertions fail loudly
//      and coverage drift is caught at PR time.
//   2. The round-trip test below knows which fixtures cover which features
//      without re-scanning at runtime.
// ---------------------------------------------------------------------------

interface ClaudeFixtureInventory {
	readonly topLevelTypes: ReadonlySet<string>;
	readonly systemSubtypes: ReadonlySet<string>;
	readonly contentBlockTypes: ReadonlySet<string>;
	readonly streamEventDeltaTypes: ReadonlySet<string>;
	readonly streamEventBlockStartTypes: ReadonlySet<string>;
}

function inventoryClaudeFixture(name: string): ClaudeFixtureInventory {
	const events = loadClaudeFixture(name);
	const topLevelTypes = new Set<string>();
	const systemSubtypes = new Set<string>();
	const contentBlockTypes = new Set<string>();
	const streamEventDeltaTypes = new Set<string>();
	const streamEventBlockStartTypes = new Set<string>();

	for (const event of events) {
		const type = event.type;
		if (typeof type === "string") topLevelTypes.add(type);

		if (type === "system" && typeof event.subtype === "string") {
			systemSubtypes.add(event.subtype);
		}

		const message = event.message as { content?: unknown } | undefined;
		const content = message?.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && "type" in block) {
					const blockType = (block as { type?: unknown }).type;
					if (typeof blockType === "string") contentBlockTypes.add(blockType);
				}
			}
		}

		if (type === "stream_event") {
			const ev = event.event as
				| { delta?: { type?: unknown }; content_block?: { type?: unknown } }
				| undefined;
			const deltaType = ev?.delta?.type;
			if (typeof deltaType === "string") streamEventDeltaTypes.add(deltaType);
			const blockStartType = ev?.content_block?.type;
			if (typeof blockStartType === "string") {
				streamEventBlockStartTypes.add(blockStartType);
			}
		}
	}

	return {
		topLevelTypes,
		systemSubtypes,
		contentBlockTypes,
		streamEventDeltaTypes,
		streamEventBlockStartTypes,
	};
}

describe("Claude fixture diversity guards", () => {
	test("thinking-text.jsonl exercises thinking + text content blocks", () => {
		const inv = inventoryClaudeFixture("thinking-text.jsonl");
		expect(inv.topLevelTypes).toContain("system");
		expect(inv.topLevelTypes).toContain("stream_event");
		expect(inv.topLevelTypes).toContain("assistant");
		expect(inv.topLevelTypes).toContain("result");
		expect(inv.systemSubtypes).toContain("init");
		expect(inv.contentBlockTypes).toContain("thinking");
		expect(inv.contentBlockTypes).toContain("text");
		expect(inv.streamEventDeltaTypes).toContain("thinking_delta");
		expect(inv.streamEventDeltaTypes).toContain("signature_delta");
		expect(inv.streamEventDeltaTypes).toContain("text_delta");
	});

	test("tool-use.jsonl exercises tool_use + tool_result + subagent task events", () => {
		const inv = inventoryClaudeFixture("tool-use.jsonl");
		expect(inv.topLevelTypes).toContain("user");
		expect(inv.contentBlockTypes).toContain("tool_use");
		expect(inv.contentBlockTypes).toContain("tool_result");
		// tool-use.jsonl was captured during a session that triggered the
		// subagent path — Task tool fires `task_started` / `task_notification`
		// system messages.
		expect(inv.systemSubtypes).toContain("task_started");
		expect(inv.systemSubtypes).toContain("task_notification");
	});

	test("todo-plan.jsonl exercises TodoWrite tool_use with input_json deltas", () => {
		const inv = inventoryClaudeFixture("todo-plan.jsonl");
		expect(inv.contentBlockTypes).toContain("tool_use");
		expect(inv.contentBlockTypes).toContain("tool_result");
		expect(inv.streamEventDeltaTypes).toContain("input_json_delta");
		// rate_limit_event is rare but shows up in this capture — pin it
		// so a future "minimal" fixture replacement loses coverage loudly.
		expect(inv.topLevelTypes).toContain("rate_limit_event");
	});

	test("bash-and-edit.jsonl exercises multi-tool sequence (Bash + Read + Edit)", () => {
		const inv = inventoryClaudeFixture("bash-and-edit.jsonl");
		expect(inv.contentBlockTypes).toContain("tool_use");
		expect(inv.contentBlockTypes).toContain("tool_result");
		// Multi-tool means multiple tool_use blocks in the stream
		const events = loadClaudeFixture("bash-and-edit.jsonl");
		const toolUseCount = events.filter((e) => {
			if (e.type !== "assistant") return false;
			const message = e.message as { content?: unknown } | undefined;
			const content = message?.content;
			if (!Array.isArray(content)) return false;
			return content.some(
				(b): b is { type: string } =>
					!!b &&
					typeof b === "object" &&
					"type" in b &&
					(b as { type?: unknown }).type === "tool_use",
			);
		}).length;
		expect(toolUseCount).toBeGreaterThanOrEqual(3);
	});
});

describe("ClaudeSessionManager.listModels", () => {
	test("returns hardcoded Claude model metadata without opening an SDK query", async () => {
		const manager = new ClaudeSessionManager();
		lastQueryArgs = null;

		const models = await manager.listModels();

		expect(models).toEqual([
			{
				id: "default",
				label: "Opus 4.7 1M",
				cliModel: "default",
				effortLevels: ["low", "medium", "high", "xhigh", "max"],
			},
			{
				id: "claude-opus-4-6[1m]",
				label: "Opus 4.6 1M",
				cliModel: "claude-opus-4-6[1m]",
				effortLevels: ["low", "medium", "high", "max"],
				supportsFastMode: true,
			},
			{
				id: "sonnet",
				label: "Sonnet",
				cliModel: "sonnet",
				effortLevels: ["low", "medium", "high", "max"],
			},
			{
				id: "haiku",
				label: "Haiku",
				cliModel: "haiku",
				effortLevels: [],
			},
		]);
		expect(lastQueryArgs).toBeNull();
	});
});

const CLAUDE_FIXTURES = [
	"thinking-text.jsonl",
	"tool-use.jsonl",
	"todo-plan.jsonl",
	"bash-and-edit.jsonl",
] as const;

describe("Claude full-fixture round-trip", () => {
	for (const fixture of CLAUDE_FIXTURES) {
		test(`${fixture} round-trips through ClaudeSessionManager without loss`, async () => {
			const sdkMessages = loadClaudeFixture(fixture);
			expect(sdkMessages.length).toBeGreaterThan(0);
			const expectedMessages = expectedSendMessageEvents(sdkMessages);

			const captured: Array<Record<string, unknown>> = [];
			const emitter = createSidecarEmitter((event) => {
				captured.push(event as Record<string, unknown>);
			});
			const manager = new ClaudeSessionManager();
			mockQueryImpl = () => asyncIterableFrom(sdkMessages);

			await manager.sendMessage(
				`REQ-${fixture}`,
				{
					sessionId: `helmor-${fixture}`,
					prompt: "fixture replay",
					model: undefined,
					cwd: undefined,
					resume: undefined,
					permissionMode: undefined,
					effortLevel: undefined,
					fastMode: undefined,
					images: [],
				},
				emitter,
			);

			// The sidecar forwards every SDK event up to the first successful
			// terminal result, optionally emits a derived `contextUsageUpdated`
			// just before `end` (when the result carries usage data), then
			// emits exactly one terminal `end`. Strip the derived event for
			// the strict passthrough count.
			const passthroughs = captured.filter(
				(e) => e.type !== "contextUsageUpdated",
			);
			expect(passthroughs).toHaveLength(expectedMessages.length + 1);
			expect(passthroughs[passthroughs.length - 1]).toEqual({
				id: `REQ-${fixture}`,
				type: "end",
			});

			// `id` always wins over any SDK-supplied id, on every event.
			for (const event of captured) {
				expect(event.id).toBe(`REQ-${fixture}`);
			}

			// `type` of every passthrough event matches the corresponding
			// source event one-for-one (in order). This is the strict
			// "no transformation, no reorder, no drop" guarantee.
			for (let i = 0; i < expectedMessages.length; i++) {
				expect(passthroughs[i]?.type).toBe(expectedMessages[i]?.type);
			}
		});
	}
});
