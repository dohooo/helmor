/**
 * Background-subagent turn-hold logic.
 *
 * When the main agent backgrounds subagents and then ends its turn, the SDK
 * (claude-agent-sdk 0.3.x) emits a normal `end_turn` `result` while the
 * subagents are still running — it does NOT emit a `background_requested`
 * pause. Closing the query then kills the live subagents. These tests pin the
 * detection (`updateOutstandingSubagents` / `shouldHoldTurnForBackground`) and
 * the end-to-end behavior: hold the turn open until the subagents finish, then
 * end exactly once.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSidecarEmitter, type SidecarEmitter } from "../src/emitter.js";

process.env.HELMOR_LOG_DIR = resolve(tmpdir(), "helmor-sidecar-test-logs");

// Mock the SDK before importing the manager (mirrors claude-session-manager.test.ts).
let mockQueryImpl: (options: unknown) => AsyncIterable<unknown> & {
	close?: () => void;
} = () => makeEmpty();

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	query: (options: unknown) => mockQueryImpl(options),
}));

const {
	ClaudeSessionManager,
	updateOutstandingSubagents,
	shouldHoldTurnForBackground,
} = await import("../src/claude/session-manager.js");

// SDKMessage is a wide union; tests construct plain shapes.
// biome-ignore lint/suspicious/noExplicitAny: test message fixtures
const msg = (o: Record<string, unknown>) => o as any;

function makeEmpty(): AsyncIterable<unknown> & { close?: () => void } {
	return {
		close: () => undefined,
		async *[Symbol.asyncIterator]() {},
	};
}

/** A push-driven async iterable: the test feeds SDK messages over time and the
 *  manager's for-await consumes them, modeling a live, still-open query. */
function controllableStream() {
	const queue: unknown[] = [];
	let wake: (() => void) | null = null;
	let ended = false;
	return {
		push(item: unknown) {
			queue.push(item);
			wake?.();
			wake = null;
		},
		end() {
			ended = true;
			wake?.();
			wake = null;
		},
		iterable: {
			close: () => undefined,
			async *[Symbol.asyncIterator]() {
				while (true) {
					while (queue.length > 0) yield queue.shift();
					if (ended) return;
					await new Promise<void>((r) => {
						wake = r;
					});
				}
			},
		} as AsyncIterable<unknown> & { close?: () => void },
	};
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 500,
) {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs)
			throw new Error(`Timed out: ${label}`);
		await new Promise((r) => setTimeout(r, 0));
	}
}

describe("updateOutstandingSubagents", () => {
	test("adds a local_agent task_started, removes it on task_notification", () => {
		const set = new Set<string>();
		updateOutstandingSubagents(
			set,
			msg({
				type: "system",
				subtype: "task_started",
				task_type: "local_agent",
				task_id: "t1",
			}),
		);
		expect(set.has("t1")).toBe(true);
		updateOutstandingSubagents(
			set,
			msg({
				type: "system",
				subtype: "task_notification",
				task_id: "t1",
				status: "completed",
			}),
		);
		expect(set.has("t1")).toBe(false);
	});

	test("ignores local_bash and local_workflow starts (not subagents to hold for)", () => {
		const set = new Set<string>();
		updateOutstandingSubagents(
			set,
			msg({
				type: "system",
				subtype: "task_started",
				task_type: "local_bash",
				task_id: "b1",
			}),
		);
		updateOutstandingSubagents(
			set,
			msg({
				type: "system",
				subtype: "task_started",
				task_type: "local_workflow",
				task_id: "w1",
			}),
		);
		expect(set.size).toBe(0);
	});

	test("a notification for an untracked id is a harmless no-op", () => {
		const set = new Set<string>(["t1"]);
		updateOutstandingSubagents(
			set,
			msg({ type: "system", subtype: "task_notification", task_id: "other" }),
		);
		expect(set.has("t1")).toBe(true);
	});

	test("tracks parallel subagents independently", () => {
		const set = new Set<string>();
		for (const id of ["a", "b"]) {
			updateOutstandingSubagents(
				set,
				msg({
					type: "system",
					subtype: "task_started",
					task_type: "local_agent",
					task_id: id,
				}),
			);
		}
		expect(set.size).toBe(2);
		updateOutstandingSubagents(
			set,
			msg({ type: "system", subtype: "task_notification", task_id: "a" }),
		);
		expect([...set]).toEqual(["b"]);
	});

	test("non-system messages are ignored", () => {
		const set = new Set<string>();
		updateOutstandingSubagents(set, msg({ type: "assistant" }));
		updateOutstandingSubagents(set, msg({ type: "result" }));
		expect(set.size).toBe(0);
	});
});

describe("shouldHoldTurnForBackground", () => {
	test("holds a terminal result while subagents are outstanding", () => {
		expect(
			shouldHoldTurnForBackground(
				msg({
					type: "result",
					subtype: "success",
					terminal_reason: "completed",
				}),
				1,
			),
		).toBe(true);
	});

	test("does not hold when nothing is outstanding", () => {
		expect(shouldHoldTurnForBackground(msg({ type: "result" }), 0)).toBe(false);
	});

	test("does not hold non-result messages", () => {
		expect(shouldHoldTurnForBackground(msg({ type: "assistant" }), 3)).toBe(
			false,
		);
	});

	test("leaves a background_requested pause to its own keep-alive path", () => {
		expect(
			shouldHoldTurnForBackground(
				msg({ type: "result", terminal_reason: "background_requested" }),
				2,
			),
		).toBe(false);
	});
});

describe("ClaudeSessionManager.sendMessage background hold", () => {
	let captured: Array<Record<string, unknown>>;
	let emitter: SidecarEmitter;
	let manager: InstanceType<typeof ClaudeSessionManager>;

	beforeEach(() => {
		captured = [];
		emitter = createSidecarEmitter((event) => {
			captured.push(event as Record<string, unknown>);
		});
		manager = new ClaudeSessionManager();
	});

	afterEach(() => {
		mockQueryImpl = () => makeEmpty();
	});

	test("holds the turn open until the background subagent finishes, then ends once", async () => {
		const ctrl = controllableStream();
		mockQueryImpl = () => ctrl.iterable;

		const sendPromise = manager.sendMessage(
			"REQ-BG",
			{
				sessionId: "s-bg",
				prompt: "research two things in the background",
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

		// Main agent launches a background subagent and then ends its turn.
		ctrl.push(
			msg({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tu1",
							name: "Agent",
							input: { description: "x" },
						},
					],
				},
			}),
		);
		ctrl.push(
			msg({
				type: "system",
				subtype: "task_started",
				task_type: "local_agent",
				task_id: "t1",
				tool_use_id: "tu1",
			}),
		);
		ctrl.push(
			msg({
				type: "result",
				subtype: "success",
				terminal_reason: "completed",
				is_error: false,
			}),
		);

		// The loop drains the queue (passthrough tool_use + task_started, hold the
		// result) and then blocks awaiting more — the turn must NOT have ended.
		await waitFor(
			() => captured.some((e) => e.subtype === "task_started"),
			"task_started passthrough",
		);
		await new Promise((r) => setTimeout(r, 5));
		expect(captured.some((e) => e.type === "end")).toBe(false);

		// Subagent finishes, then the main agent produces its final turn result.
		ctrl.push(
			msg({
				type: "system",
				subtype: "task_notification",
				task_id: "t1",
				status: "completed",
				summary: "done",
			}),
		);
		ctrl.push(
			msg({
				type: "result",
				subtype: "success",
				terminal_reason: "completed",
				is_error: false,
			}),
		);

		await sendPromise;

		// Exactly one terminal `end`, and it is the last event.
		const ends = captured.filter((e) => e.type === "end");
		expect(ends).toHaveLength(1);
		expect(captured[captured.length - 1]).toEqual({
			id: "REQ-BG",
			type: "end",
		});

		// The intermediate (held) result was NOT forwarded — only the final one.
		const results = captured.filter((e) => e.type === "result");
		expect(results).toHaveLength(1);

		// The subagent lifecycle events still flowed through to the pipeline.
		expect(captured.some((e) => e.subtype === "task_started")).toBe(true);
		expect(captured.some((e) => e.subtype === "task_notification")).toBe(true);
	});
});
