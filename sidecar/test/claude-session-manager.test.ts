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
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSidecarEmitter, type SidecarEmitter } from "../src/emitter.js";

// ---------------------------------------------------------------------------
// Mock the Claude Agent SDK BEFORE importing anything that uses it.
// A closure variable lets each test supply its own async iterator.
// ---------------------------------------------------------------------------

type MockQueryResult = AsyncIterable<unknown> & {
	supportedModels?: () => Promise<
		Array<{
			value: string;
			displayName?: string;
			supportedEffortLevels?: string[];
		}>
	>;
	supportedCommands?: () => Promise<
		Array<{
			name: string;
			description: string;
			argumentHint?: string;
		}>
	>;
	close?: () => void;
};

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
	supportedModels,
	supportedCommands,
	close,
}: {
	stream?: readonly unknown[];
	supportedModels?: MockQueryResult["supportedModels"];
	supportedCommands?: MockQueryResult["supportedCommands"];
	close?: () => void;
} = {}): MockQueryResult {
	const iterable = asyncIterableFrom(stream);
	return {
		supportedModels,
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
			},
			emitter,
		);

		// One event per SDK message plus a trailing `end`
		expect(captured).toHaveLength(sdkMessages.length + 1);

		const last = captured[captured.length - 1];
		expect(last).toEqual({ id: "REQ-1", type: "end" });
	});

	test("lists fast mode support only for opus-class models", async () => {
		mockQueryImpl = () =>
			makeMockQuery({
				supportedModels: async () => [
					{
						value: "default",
						displayName: "Default",
						supportedEffortLevels: ["low", "medium", "high", "max"],
					},
					{
						value: "claude-opus-4-6",
						displayName: "Claude Opus 4.6",
						supportedEffortLevels: ["low", "medium", "high", "max"],
					},
					{
						value: "claude-sonnet-4-6",
						displayName: "Claude Sonnet 4.6",
						supportedEffortLevels: ["low", "medium", "high"],
					},
				],
			});

		const models = await manager.listModels();

		expect(models).toEqual([
			expect.objectContaining({
				id: "default",
				supportsFastMode: true,
			}),
			expect.objectContaining({
				id: "claude-opus-4-6",
				supportsFastMode: true,
			}),
			expect.objectContaining({
				id: "claude-sonnet-4-6",
				supportsFastMode: false,
			}),
		]);
	});

	test("ignores fast mode for non-opus Claude models", async () => {
		mockQueryImpl = () => makeMockQuery();

		await manager.sendMessage(
			"REQ-fast-sonnet",
			{
				sessionId: "helmor-sess-fast-sonnet",
				prompt: "test",
				model: "claude-sonnet-4-6",
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
				fastMode: true,
			},
			emitter,
		);

		const args = lastQueryArgs as {
			options?: { settings?: Record<string, unknown> };
		};
		expect(args.options?.settings).toBeUndefined();
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
			},
			emitter,
		);

		// The passthrough events (everything except the final `end`) must
		// still carry the SDK's session_id verbatim — that's how the Rust
		// side learns the provider_session_id to persist.
		const passthroughs = captured.slice(0, -1);
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
				},
				emitter,
			),
		).rejects.toThrow("upstream 500");

		// One passthrough got through before the throw. No `end`, no `aborted`.
		expect(captured).toHaveLength(1);
		expect(captured.some((e) => e.type === "end")).toBe(false);
		expect(captured.some((e) => e.type === "aborted")).toBe(false);
	});

	test("adds worktree git metadata directories to Claude query options", async () => {
		const workspaceDir = makeTempDir("helmor-claude-worktree-");
		const repoRoot = makeTempDir("helmor-claude-repo-");
		const gitCommonDir = resolve(repoRoot, ".git");
		const gitDir = resolve(gitCommonDir, "worktrees", "alnitak");

		mkdirSync(gitDir, { recursive: true });
		writeFileSync(resolve(workspaceDir, ".git"), `gitdir: ${gitDir}\n`);
		writeFileSync(resolve(gitDir, "commondir"), "../../\n");

		mockQueryImpl = () => asyncIterableFrom([{ type: "result", result: "ok" }]);

		await manager.sendMessage(
			"REQ-WORKTREE",
			{
				sessionId: "s-worktree",
				prompt: "commit the changes",
				model: "opus-1m",
				cwd: workspaceDir,
				resume: undefined,
				permissionMode: "bypassPermissions",
				effortLevel: undefined,
				fastMode: undefined,
			},
			emitter,
		);

		expect(lastQueryArgs).toMatchObject({
			options: {
				cwd: workspaceDir,
				additionalDirectories: [gitDir, gitCommonDir],
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
	test("returns formatted Claude model metadata", async () => {
		const manager = new ClaudeSessionManager();
		lastQueryArgs = null;
		mockQueryImpl = () =>
			makeMockQuery({
				supportedModels: async () => [
					{ value: "default", displayName: "Default" },
					{
						value: "sonnet",
						displayName: "Sonnet (1M context)",
						supportedEffortLevels: ["low", "medium", "high"],
					},
					{ value: "haiku", displayName: "Haiku" },
				],
			});

		const models = await manager.listModels();

		expect(models).toEqual([
			{
				id: "default",
				label: "Opus 4.6 1M",
				cliModel: "default",
				effortLevels: ["low", "medium", "high", "max"],
				supportsFastMode: true,
			},
			{
				id: "sonnet",
				label: "Sonnet 1M",
				cliModel: "sonnet",
				effortLevels: ["low", "medium", "high"],
				supportsFastMode: false,
			},
			{
				id: "haiku",
				label: "Haiku",
				cliModel: "haiku",
				effortLevels: ["low", "medium", "high"],
				supportsFastMode: false,
			},
		]);
		expect(lastQueryArgs).toMatchObject({
			options: {
				settingSources: ["user", "project", "local"],
			},
		});
	});

	test("propagates supportedModels failures", async () => {
		const manager = new ClaudeSessionManager();
		mockQueryImpl = () =>
			makeMockQuery({
				supportedModels: async () => {
					throw new Error("supportedModels exploded");
				},
			});

		await expect(manager.listModels()).rejects.toThrow(
			"supportedModels exploded",
		);
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
				},
				emitter,
			);

			// The sidecar forwards every SDK event up to the first successful
			// terminal result, then emits exactly one terminal `end`.
			expect(captured).toHaveLength(expectedMessages.length + 1);
			expect(captured[captured.length - 1]).toEqual({
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
				expect(captured[i]?.type).toBe(expectedMessages[i]?.type);
			}
		});
	}
});
