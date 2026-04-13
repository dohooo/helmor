/**
 * CodexSessionManager integration test.
 *
 * Mirror of `claude-session-manager.test.ts`: feeds a real captured
 * Codex stream fixture through a mocked `@openai/codex-sdk` and asserts
 * on the resulting emitter events. Fixture was captured via
 * `sidecar/scripts/capture-codex-fixture.ts` against the live SDK, so
 * what we replay here is byte-for-byte what the manager originally
 * emitted.
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
// Mock `@openai/codex-sdk` BEFORE importing anything that uses it.
// The Codex shape is: `new Codex()` → `codex.startThread(opts)` → thread with
// `runStreamed(input, {signal})` → `streamedTurn.events` async iterable, plus
// `thread.id` for the thread/session id the manager injects as `session_id`.
// ---------------------------------------------------------------------------

const MOCK_THREAD_ID = "mock-thread-id-for-tests";

type CodexEvent = Record<string, unknown>;

interface MockThread {
	readonly id: string;
	runStreamed: (
		input: unknown,
		opts?: { signal?: AbortSignal },
	) => Promise<{ events: AsyncIterable<CodexEvent> }>;
}

let mockEvents: readonly CodexEvent[] = [];
let lastThreadOptions: unknown = null;
let lastRunInput: unknown = null;
let mockStreamFactory: (
	opts: { signal?: AbortSignal } | undefined,
) => AsyncIterable<CodexEvent> = () => asyncIterableFrom(mockEvents);

class MockCodex {
	startThread(opts: unknown): MockThread {
		lastThreadOptions = opts;
		return {
			id: MOCK_THREAD_ID,
			runStreamed: async (input, opts) => {
				lastRunInput = input;
				return { events: mockStreamFactory(opts) };
			},
		};
	}
	resumeThread(_id: string, _opts: unknown): MockThread {
		return this.startThread(_opts);
	}
}

mock.module("@openai/codex-sdk", () => ({
	Codex: MockCodex,
}));

// Dynamic import AFTER the mock is registered.
const { CodexSessionManager } = await import("../src/codex-session-manager.js");

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

const CODEX_FIXTURE_ROOT = resolve(
	import.meta.dir,
	"../../src-tauri/tests/fixtures/streams/codex",
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

function loadCodexFixture(fixtureName: string): CodexEvent[] {
	const raw = readFileSync(resolve(CODEX_FIXTURE_ROOT, fixtureName), "utf-8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as CodexEvent)
		.filter((event) => event.type !== "end")
		.map((event) => {
			// The capture-time recording passed through the manager's
			// `passthrough(requestId, { ...event, session_id })`, which means
			// the on-disk fixture has an injected `session_id`. Strip it
			// here so what we hand back to the mocked SDK is as close to
			// raw SDK output as possible — the manager under test will
			// re-inject its own (from MOCK_THREAD_ID).
			const { session_id: _discard, ...rest } = event;
			return rest;
		});
}

async function* asyncIterableFrom<T>(items: readonly T[]): AsyncGenerator<T> {
	for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodexSessionManager.sendMessage", () => {
	let captured: Array<Record<string, unknown>>;
	let emitter: SidecarEmitter;
	let manager: InstanceType<typeof CodexSessionManager>;

	beforeEach(() => {
		captured = [];
		emitter = createSidecarEmitter((event) => {
			captured.push(event as Record<string, unknown>);
		});
		manager = new CodexSessionManager();
		mockEvents = [];
		mockStreamFactory = () => asyncIterableFrom(mockEvents);
		lastThreadOptions = null;
		lastRunInput = null;
	});

	test("forwards every SDK event as passthrough and ends with 'end'", async () => {
		const sdkEvents = loadCodexFixture("list-files.jsonl");
		expect(sdkEvents.length).toBeGreaterThan(0);
		mockEvents = sdkEvents;

		await manager.sendMessage(
			"REQ-CODEX-1",
			{
				sessionId: "helmor-sess-codex-1",
				prompt: "list files",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
			},
			emitter,
		);

		// One passthrough per SDK event + one trailing `end`
		expect(captured).toHaveLength(sdkEvents.length + 1);

		const last = captured[captured.length - 1];
		expect(last).toEqual({ id: "REQ-CODEX-1", type: "end" });
	});

	test("every forwarded event carries our requestId", async () => {
		mockEvents = loadCodexFixture("list-files.jsonl");

		await manager.sendMessage(
			"UNIQUE-REQ",
			{
				sessionId: "s1",
				prompt: "x",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
			},
			emitter,
		);

		for (const event of captured) {
			expect(event.id).toBe("UNIQUE-REQ");
		}
	});

	test("injects session_id from thread.id into every forwarded event", async () => {
		mockEvents = loadCodexFixture("list-files.jsonl");

		await manager.sendMessage(
			"REQ-SID",
			{
				sessionId: "helmor-sess",
				prompt: "x",
				model: undefined,
				cwd: undefined,
				resume: undefined,
				permissionMode: undefined,
				effortLevel: undefined,
			},
			emitter,
		);

		// Every passthrough (all but the trailing `end`) should carry the
		// MOCK_THREAD_ID as session_id — this is the single contract
		// Codex events rely on for Rust-side provider_session_id capture.
		const passthroughs = captured.slice(0, -1);
		expect(passthroughs.length).toBeGreaterThan(0);
		for (const event of passthroughs) {
			expect(event.session_id).toBe(MOCK_THREAD_ID);
		}
	});

	test("fixture contains the expected Codex event diversity", () => {
		// The fixture must exercise multiple Codex event types so the tests
		// above aren't trivially passing on a degenerate stream.
		const events = loadCodexFixture("list-files.jsonl");
		const types = new Set(events.map((e) => e.type));
		expect(types.has("thread.started")).toBe(true);
		expect(types.has("turn.started")).toBe(true);
		expect(types.has("item.completed")).toBe(true);
		expect(types.has("turn.completed")).toBe(true);

		const itemTypes = new Set(
			events
				.filter((e) => e.type === "item.completed" || e.type === "item.started")
				.map((e) => {
					const item = e.item as { type?: unknown } | undefined;
					return item?.type;
				}),
		);
		expect(itemTypes.has("agent_message")).toBe(true);
		expect(itemTypes.has("command_execution")).toBe(true);
	});

	test("emits an `aborted` event when the SDK throws AbortError", async () => {
		const fixtureEvents = loadCodexFixture("list-files.jsonl");
		mockStreamFactory = () =>
			(async function* aborter() {
				yield fixtureEvents[0] as CodexEvent;
				yield fixtureEvents[1] as CodexEvent;
				const err = new Error("The operation was aborted") as Error & {
					name: string;
				};
				err.name = "AbortError";
				throw err;
			})();

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
			},
			emitter,
		);

		// Two passthroughs + one aborted terminal. No `end` event.
		expect(captured).toHaveLength(3);
		expect(captured[captured.length - 1]).toEqual({
			id: "REQ-ABORT",
			type: "aborted",
			reason: "user_requested",
		});
		expect(captured.some((e) => e.type === "end")).toBe(false);
	});

	test("propagates non-abort errors (manager does NOT swallow them)", async () => {
		mockStreamFactory = () =>
			(async function* boomer() {
				yield { type: "thread.started" } as CodexEvent;
				throw new Error("upstream 500");
			})();

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
				},
				emitter,
			),
		).rejects.toThrow("upstream 500");

		// One passthrough got through before the throw. No `end`, no `aborted`.
		expect(captured).toHaveLength(1);
		expect(captured.some((e) => e.type === "end")).toBe(false);
		expect(captured.some((e) => e.type === "aborted")).toBe(false);
	});

	test("plan mode uses read-only sandbox and prepends a plan-only instruction", async () => {
		mockEvents = [{ type: "thread.started" }, { type: "turn.completed" }];

		await manager.sendMessage(
			"REQ-PLAN",
			{
				sessionId: "s-plan",
				prompt: "Inspect the repo and tell me what to change",
				model: "gpt-5.4",
				cwd: "/tmp/project",
				resume: undefined,
				permissionMode: "plan",
				effortLevel: undefined,
			},
			emitter,
		);

		expect(lastThreadOptions).toMatchObject({
			model: "gpt-5.4",
			workingDirectory: "/tmp/project",
			sandboxMode: "read-only",
			approvalPolicy: "never",
		});
		expect(lastRunInput).toBeString();
		expect(lastRunInput).toContain("Plan mode is enabled.");
		expect(lastRunInput).toContain("produce a concrete plan only");
		expect(lastRunInput).toContain("User request:");
	});

	test("adds worktree git metadata directories to thread options", async () => {
		mockEvents = [{ type: "thread.started" }, { type: "turn.completed" }];
		const workspaceDir = makeTempDir("helmor-codex-worktree-");
		const repoRoot = makeTempDir("helmor-codex-repo-");
		const gitCommonDir = resolve(repoRoot, ".git");
		const gitDir = resolve(gitCommonDir, "worktrees", "alnitak");

		mkdirSync(gitDir, { recursive: true });
		writeFileSync(resolve(workspaceDir, ".git"), `gitdir: ${gitDir}\n`);
		writeFileSync(resolve(gitDir, "commondir"), "../../\n");

		await manager.sendMessage(
			"REQ-WORKTREE",
			{
				sessionId: "s-worktree",
				prompt: "commit the changes",
				model: "gpt-5.4",
				cwd: workspaceDir,
				resume: undefined,
				permissionMode: "bypassPermissions",
				effortLevel: undefined,
			},
			emitter,
		);

		expect(lastThreadOptions).toMatchObject({
			workingDirectory: workspaceDir,
			additionalDirectories: [gitDir, gitCommonDir],
		});
	});
});

describe("CodexSessionManager.stopSession", () => {
	test("no-op on unknown sessionId", async () => {
		const manager = new CodexSessionManager();
		await manager.stopSession("never-existed");
	});
});

// ---------------------------------------------------------------------------
// Per-fixture diversity guards.
//
// Each captured fixture is a snapshot of real Codex SDK output. These tests
// pin which event/item types each fixture exercises so that:
//   1. If anyone trims or replaces a fixture, the assertions fail loudly
//      and coverage drift is caught at PR time.
//   2. The round-trip test below knows which fixtures cover which features
//      without re-scanning at runtime.
// ---------------------------------------------------------------------------

interface CodexFixtureInventory {
	readonly eventTypes: ReadonlySet<string>;
	readonly itemTypes: ReadonlySet<string>;
}

function inventoryCodexFixture(name: string): CodexFixtureInventory {
	const events = loadCodexFixture(name);
	const eventTypes = new Set<string>();
	const itemTypes = new Set<string>();

	for (const event of events) {
		const type = event.type;
		if (typeof type === "string") eventTypes.add(type);

		const item = event.item as { type?: unknown } | undefined;
		const itemType = item?.type;
		if (typeof itemType === "string") itemTypes.add(itemType);
	}

	return { eventTypes, itemTypes };
}

describe("Codex fixture diversity guards", () => {
	test("list-files.jsonl exercises baseline thread/turn/item flow with command_execution", () => {
		const inv = inventoryCodexFixture("list-files.jsonl");
		expect(inv.eventTypes).toContain("thread.started");
		expect(inv.eventTypes).toContain("turn.started");
		expect(inv.eventTypes).toContain("item.started");
		expect(inv.eventTypes).toContain("item.completed");
		expect(inv.eventTypes).toContain("turn.completed");
		expect(inv.itemTypes).toContain("agent_message");
		expect(inv.itemTypes).toContain("command_execution");
	});

	test("reasoning.jsonl exercises text-only minimal shape (no command_execution)", () => {
		const inv = inventoryCodexFixture("reasoning.jsonl");
		expect(inv.eventTypes).toContain("thread.started");
		expect(inv.eventTypes).toContain("turn.completed");
		expect(inv.itemTypes).toContain("agent_message");
		// Pin the absence of command_execution — this fixture's purpose is
		// the no-tool-use happy path.
		expect(inv.itemTypes.has("command_execution")).toBe(false);
	});

	test("multi-step.jsonl exercises item.updated + todo_list (plan) item", () => {
		const inv = inventoryCodexFixture("multi-step.jsonl");
		expect(inv.eventTypes).toContain("item.started");
		expect(inv.eventTypes).toContain("item.updated");
		expect(inv.eventTypes).toContain("item.completed");
		expect(inv.itemTypes).toContain("todo_list");
		expect(inv.itemTypes).toContain("command_execution");
		expect(inv.itemTypes).toContain("agent_message");
	});

	test("the codex/ corpus collectively reaches every event we expect", () => {
		const all = new Set<string>();
		for (const name of [
			"list-files.jsonl",
			"reasoning.jsonl",
			"multi-step.jsonl",
		]) {
			for (const t of inventoryCodexFixture(name).eventTypes) all.add(t);
		}
		// Every reachable Codex ThreadEvent variant we have a real capture for.
		expect(all).toContain("thread.started");
		expect(all).toContain("turn.started");
		expect(all).toContain("item.started");
		expect(all).toContain("item.updated");
		expect(all).toContain("item.completed");
		expect(all).toContain("turn.completed");
	});

	test("the codex/ corpus collectively reaches every item type we expect", () => {
		const all = new Set<string>();
		for (const name of [
			"list-files.jsonl",
			"reasoning.jsonl",
			"multi-step.jsonl",
		]) {
			for (const t of inventoryCodexFixture(name).itemTypes) all.add(t);
		}
		expect(all).toContain("agent_message");
		expect(all).toContain("command_execution");
		expect(all).toContain("todo_list");
	});
});

const CODEX_FIXTURES = [
	"list-files.jsonl",
	"reasoning.jsonl",
	"multi-step.jsonl",
] as const;

describe("Codex full-fixture round-trip", () => {
	for (const fixture of CODEX_FIXTURES) {
		test(`${fixture} round-trips through CodexSessionManager without loss`, async () => {
			const sdkEvents = loadCodexFixture(fixture);
			expect(sdkEvents.length).toBeGreaterThan(0);

			const captured: Array<Record<string, unknown>> = [];
			const emitter = createSidecarEmitter((event) => {
				captured.push(event as Record<string, unknown>);
			});
			const manager = new CodexSessionManager();
			mockEvents = sdkEvents;
			mockStreamFactory = () => asyncIterableFrom(mockEvents);

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

			// One passthrough per SDK event + one terminal `end`.
			expect(captured).toHaveLength(sdkEvents.length + 1);
			expect(captured[captured.length - 1]).toEqual({
				id: `REQ-${fixture}`,
				type: "end",
			});

			// `id` always wins on every event.
			for (const event of captured) {
				expect(event.id).toBe(`REQ-${fixture}`);
			}

			// `type` of every passthrough matches one-for-one (no transform,
			// no reorder, no drop).
			for (let i = 0; i < sdkEvents.length; i++) {
				expect(captured[i]?.type).toBe(sdkEvents[i]?.type);
			}

			// session_id is injected from MOCK_THREAD_ID on every passthrough
			// (the manager's contract; Codex events don't carry one natively).
			for (let i = 0; i < sdkEvents.length; i++) {
				expect(captured[i]?.session_id).toBe(MOCK_THREAD_ID);
			}
		});
	}
});
