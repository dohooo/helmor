/**
 * Regression for issue #891: backgrounded subagents never resumed the main
 * turn. The SDK signals a backgrounded task with an intermediate `result`
 * whose `terminal_reason === "background_requested"`, keeps the SAME query()
 * alive, then resumes via `task_notification` to a real terminal result.
 *
 * The old loop treated ANY `result` as terminal: it fired `end` on the pause
 * and `q.close()` tore the session down, so the later `task_notification` was
 * lost and the turn ended prematurely.
 *
 * Fix under test (`session-manager.ts`): a `background_requested` result is
 * filtered before passthrough — usage is still recorded via
 * `contextUsageUpdated`, but it never reaches the pipeline and never fires
 * `end`. The loop keeps draining until the genuinely terminal result.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SendMessageParams } from "../session-manager.js";

// The mocked query() returns whatever the active scenario holds. A single
// mocked binding (resolved at session-manager import time) reads this mutable
// outer variable so each test can swap the SDK message stream.
let scenario: SDKMessage[] = [];
let hangAfterScenario = false;
const previousBgDrainTimeout = process.env.HELMOR_CLAUDE_BG_DRAIN_TIMEOUT_MS;

function makeQuery(messages: SDKMessage[]) {
	let closed = false;
	let releaseHang: (() => void) | null = null;
	return {
		async *[Symbol.asyncIterator]() {
			for (const m of messages) {
				if (closed) return;
				yield m;
			}
			if (hangAfterScenario && !closed) {
				// The production drain timer is `.unref()`'d so a real 20-min drain
				// can't block sidecar shutdown. That timer is what fires `q.close()`
				// to release this hang. But an unref'd timer only fires while the
				// event loop is otherwise kept alive — and once this iterator parks
				// there is no other ref'd handle in user space. On macOS/Linux Bun
				// the timer still fires; on Windows Bun it doesn't, wedging the whole
				// `bun test` process until the CI job hits its 20-min timeout. Hold a
				// ref'd heartbeat while parked so the drain timer fires deterministically
				// on every platform; it's cleared the instant `close()` resolves us.
				const heartbeat = setInterval(() => {}, 1000);
				try {
					await new Promise<void>((resolve) => {
						releaseHang = resolve;
					});
				} finally {
					clearInterval(heartbeat);
				}
			}
		},
		close() {
			closed = true;
			releaseHang?.();
		},
	};
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	query: () => makeQuery(scenario),
}));

interface EmitterSpy {
	passthroughs: object[];
	contextUsageUpdates: number;
	ends: number;
	emitter: import("../emitter.js").SidecarEmitter;
}

function makeSpyEmitter(): EmitterSpy {
	const spy: EmitterSpy = {
		passthroughs: [],
		contextUsageUpdates: 0,
		ends: 0,
		emitter: undefined as unknown as import("../emitter.js").SidecarEmitter,
	};
	// Proxy: record the methods we assert on, no-op everything else so an
	// incidental call (e.g. logging) can't blow up the test.
	spy.emitter = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "passthrough") {
					return (_id: string, message: object) =>
						spy.passthroughs.push(message);
				}
				if (prop === "contextUsageUpdated") {
					return () => {
						spy.contextUsageUpdates += 1;
					};
				}
				if (prop === "end") {
					return () => {
						spy.ends += 1;
					};
				}
				return () => undefined;
			},
		},
	) as import("../emitter.js").SidecarEmitter;
	return spy;
}

const MODEL = "claude-test";
// Shape buildClaudeStoredMeta needs to return non-null so the pause records usage.
const USAGE = { input_tokens: 1000, output_tokens: 500 };
const MODEL_USAGE = { [MODEL]: { contextWindow: 200_000 } };

function assistant(text: string): SDKMessage {
	return {
		type: "assistant",
		message: { role: "assistant", content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		session_id: "s1",
		uuid: `a-${text}`,
	} as unknown as SDKMessage;
}

function result(terminalReason: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		result: terminalReason,
		terminal_reason: terminalReason,
		usage: USAGE,
		modelUsage: MODEL_USAGE,
		session_id: "s1",
		uuid: `r-${terminalReason}`,
	} as unknown as SDKMessage;
}

function taskNotification(taskId = "t1"): SDKMessage {
	return {
		type: "system",
		subtype: "task_notification",
		task_id: taskId,
		status: "completed",
		output_file: "",
		summary: "done",
		session_id: "s1",
		uuid: `tn-${taskId}`,
	} as unknown as SDKMessage;
}

function taskStarted(taskId = "t1"): SDKMessage {
	return {
		type: "system",
		subtype: "task_started",
		task_id: taskId,
		tool_use_id: `tu-${taskId}`,
		parent_tool_use_id: null,
		session_id: "s1",
		uuid: `ts-${taskId}`,
	} as unknown as SDKMessage;
}

function baseParams(): SendMessageParams {
	return {
		sessionId: "s1",
		prompt: "research X in the background then synthesize",
		model: MODEL,
		cwd: undefined,
		resume: undefined,
		permissionMode: "bypassPermissions",
		effortLevel: undefined,
		fastMode: undefined,
	} as SendMessageParams;
}

let ClaudeSessionManager: typeof import("./session-manager.js").ClaudeSessionManager;

beforeAll(async () => {
	({ ClaudeSessionManager } = await import("./session-manager.js"));
});

afterEach(() => {
	scenario = [];
	hangAfterScenario = false;
	if (previousBgDrainTimeout === undefined) {
		delete process.env.HELMOR_CLAUDE_BG_DRAIN_TIMEOUT_MS;
	} else {
		process.env.HELMOR_CLAUDE_BG_DRAIN_TIMEOUT_MS = previousBgDrainTimeout;
	}
});

describe("ClaudeSessionManager backgrounded-task resume (#891)", () => {
	test("filters the pause result, resumes, and ends exactly once", async () => {
		scenario = [
			assistant("starting"),
			result("background_requested"),
			taskNotification(),
			assistant("synthesizing"),
			result("completed"),
		];
		const spy = makeSpyEmitter();
		const manager = new ClaudeSessionManager();

		await manager.sendMessage("req-1", baseParams(), spy.emitter);

		// Exactly one terminal end — NOT one per result.
		expect(spy.ends).toBe(1);

		// The pause result is never passed into the pipeline.
		const passedReasons = spy.passthroughs
			.map((m) => (m as { terminal_reason?: string }).terminal_reason)
			.filter(Boolean);
		expect(passedReasons).not.toContain("background_requested");
		expect(passedReasons).toContain("completed");

		// Continuation flows through: task_notification + the post-resume assistant.
		const subtypes = spy.passthroughs.map(
			(m) => (m as { subtype?: string }).subtype,
		);
		expect(subtypes).toContain("task_notification");
		const assistantTexts = spy.passthroughs
			.filter((m) => (m as { type?: string }).type === "assistant")
			.map(
				(m) =>
					(m as { message?: { content?: { text?: string }[] } }).message
						?.content?.[0]?.text,
			);
		expect(assistantTexts).toContain("synthesizing");

		// Usage recorded at both the pause and the terminal result.
		expect(spy.contextUsageUpdates).toBeGreaterThanOrEqual(2);
	});

	test("if the SDK closes after a pause, the post-loop end still fires", async () => {
		// Safe-fallback: an older/future SDK could end the iterator right after
		// the pause instead of resuming. The loop exits naturally and the
		// post-loop end fires — no hang, no lost terminal event.
		scenario = [assistant("starting"), result("background_requested")];
		const spy = makeSpyEmitter();
		const manager = new ClaudeSessionManager();

		await manager.sendMessage("req-2", baseParams(), spy.emitter);

		expect(spy.ends).toBe(1);
		const passedReasons = spy.passthroughs
			.map((m) => (m as { terminal_reason?: string }).terminal_reason)
			.filter(Boolean);
		expect(passedReasons).not.toContain("background_requested");
	});
});

describe("ClaudeSessionManager run_in_background drain (completed with pending bg tasks)", () => {
	const completedResultCount = (spy: EmitterSpy) =>
		spy.passthroughs.filter(
			(m) =>
				(m as { type?: string }).type === "result" &&
				(m as { terminal_reason?: string }).terminal_reason === "completed",
		).length;

	test("defers `completed` while a bg task is pending, resumes on task_notification, ends once", async () => {
		scenario = [
			assistant("dispatching"),
			taskStarted("bg1"),
			result("completed"), // intermediate — bg1 still pending, must be deferred
			taskNotification("bg1"), // bg1 settles
			assistant("synthesizing"),
			result("completed"), // genuinely terminal
		];
		const spy = makeSpyEmitter();
		await new ClaudeSessionManager().sendMessage(
			"req-bg-1",
			baseParams(),
			spy.emitter,
		);

		// One terminal end — the intermediate `completed` must not fire it.
		expect(spy.ends).toBe(1);
		// Only the FINAL `completed` reaches the pipeline (one result per turn).
		expect(completedResultCount(spy)).toBe(1);
		// Continuation flows through: notification + the post-resume assistant.
		const subtypes = spy.passthroughs.map(
			(m) => (m as { subtype?: string }).subtype,
		);
		expect(subtypes).toContain("task_notification");
		const assistantTexts = spy.passthroughs
			.filter((m) => (m as { type?: string }).type === "assistant")
			.map(
				(m) =>
					(m as { message?: { content?: { text?: string }[] } }).message
						?.content?.[0]?.text,
			);
		expect(assistantTexts).toContain("synthesizing");
		// Usage recorded at the deferred pause AND the terminal result.
		expect(spy.contextUsageUpdates).toBeGreaterThanOrEqual(2);
	});

	test("waits for ALL of several bg tasks before ending", async () => {
		scenario = [
			assistant("dispatch 3"),
			taskStarted("a"),
			taskStarted("b"),
			taskStarted("c"),
			result("completed"), // pending {a,b,c} — deferred
			taskNotification("a"),
			result("completed"), // pending {b,c} — deferred
			taskNotification("b"),
			taskNotification("c"), // pending now empty
			assistant("all settled"),
			result("completed"), // terminal
		];
		const spy = makeSpyEmitter();
		await new ClaudeSessionManager().sendMessage(
			"req-bg-2",
			baseParams(),
			spy.emitter,
		);

		expect(spy.ends).toBe(1);
		expect(completedResultCount(spy)).toBe(1); // only the final completed
		const notifs = spy.passthroughs.filter(
			(m) => (m as { subtype?: string }).subtype === "task_notification",
		);
		expect(notifs).toHaveLength(3);
	});

	test("safe fallback: SDK ends the iterator before the notification arrives", async () => {
		scenario = [
			assistant("dispatching"),
			taskStarted("bg1"),
			result("completed"), // deferred; iterator then ends without a notification
		];
		const spy = makeSpyEmitter();
		await new ClaudeSessionManager().sendMessage(
			"req-bg-3",
			baseParams(),
			spy.emitter,
		);

		// Loop exits naturally → post-loop end fires once; no hang, no double end.
		expect(spy.ends).toBe(1);
		expect(completedResultCount(spy)).toBe(0); // deferred, never reached pipeline
	});

	test("forces end after the background drain timeout if a pending task never notifies", async () => {
		process.env.HELMOR_CLAUDE_BG_DRAIN_TIMEOUT_MS = "5";
		hangAfterScenario = true;
		scenario = [
			assistant("dispatching"),
			taskStarted("bg1"),
			result("completed"), // deferred; query then stays open forever
		];
		const spy = makeSpyEmitter();
		await new ClaudeSessionManager().sendMessage(
			"req-bg-timeout",
			baseParams(),
			spy.emitter,
		);

		expect(spy.ends).toBe(1);
		expect(completedResultCount(spy)).toBe(0);
	});

	test("error terminal is NOT deferred even with a bg task pending", async () => {
		scenario = [
			assistant("dispatching"),
			taskStarted("bg1"),
			result("max_turns"), // non-`completed` terminal — must end immediately
		];
		const spy = makeSpyEmitter();
		await new ClaudeSessionManager().sendMessage(
			"req-bg-4",
			baseParams(),
			spy.emitter,
		);

		expect(spy.ends).toBe(1);
		const reasons = spy.passthroughs
			.map((m) => (m as { terminal_reason?: string }).terminal_reason)
			.filter(Boolean);
		expect(reasons).toContain("max_turns"); // passed through, not deferred
	});
});
