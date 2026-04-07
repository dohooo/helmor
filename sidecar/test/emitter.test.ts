import { beforeEach, describe, expect, test } from "bun:test";
import { createSidecarEmitter, type SidecarEmitter } from "../src/emitter.js";

describe("createSidecarEmitter", () => {
	let captured: object[];
	let emitter: SidecarEmitter;

	beforeEach(() => {
		captured = [];
		emitter = createSidecarEmitter((event) => {
			captured.push(event);
		});
	});

	test("ready emits version", () => {
		emitter.ready(1);
		expect(captured).toEqual([{ type: "ready", version: 1 }]);
	});

	test("end includes request id and type only", () => {
		emitter.end("req-1");
		expect(captured).toEqual([{ id: "req-1", type: "end" }]);
	});

	test("aborted includes reason", () => {
		emitter.aborted("req-1", "user_requested");
		expect(captured).toEqual([
			{ id: "req-1", type: "aborted", reason: "user_requested" },
		]);
	});

	test("error with request id", () => {
		emitter.error("req-1", "boom");
		expect(captured).toEqual([{ id: "req-1", type: "error", message: "boom" }]);
	});

	test("error without request id (top-level parse failure)", () => {
		emitter.error(null, "invalid json");
		expect(captured).toEqual([{ type: "error", message: "invalid json" }]);
	});

	test("stopped includes the stopped sessionId", () => {
		emitter.stopped("req-stop", "s-42");
		expect(captured).toEqual([
			{ id: "req-stop", type: "stopped", sessionId: "s-42" },
		]);
	});

	test("pong is a minimal envelope", () => {
		emitter.pong("req-ping");
		expect(captured).toEqual([{ id: "req-ping", type: "pong" }]);
	});

	test("titleGenerated passes branchName through (including undefined)", () => {
		emitter.titleGenerated("req-t", "A title", "a-branch");
		emitter.titleGenerated("req-t2", "No branch", undefined);
		expect(captured).toEqual([
			{
				id: "req-t",
				type: "titleGenerated",
				title: "A title",
				branchName: "a-branch",
			},
			{
				id: "req-t2",
				type: "titleGenerated",
				title: "No branch",
				branchName: undefined,
			},
		]);
	});

	describe("passthrough", () => {
		test("forwards arbitrary SDK message fields", () => {
			emitter.passthrough("req-x", {
				type: "assistant",
				session_id: "sdk-sess",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			});
			expect(captured).toEqual([
				{
					type: "assistant",
					session_id: "sdk-sess",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
					},
					id: "req-x",
				},
			]);
		});

		test("id is ALWAYS our request id, even if the SDK message carries its own id", () => {
			// `passthrough` must spread the message first and apply `id` last
			// so an SDK-supplied `id` field can never win the collision.
			emitter.passthrough("MY-REQ", {
				type: "result",
				id: "sdk-internal-id-that-should-NOT-win",
				result: "done",
			});
			expect(captured).toHaveLength(1);
			const event = captured[0] as Record<string, unknown>;
			expect(event.id).toBe("MY-REQ");
			expect(event.type).toBe("result");
			expect(event.result).toBe("done");
		});

		test("preserves snake_case session_id from SDK message (no transform)", () => {
			emitter.passthrough("req-y", {
				type: "stream_event",
				session_id: "sdk-sess-123",
				event: { delta: { text: "hello" } },
			});
			const event = captured[0] as Record<string, unknown>;
			expect(event.session_id).toBe("sdk-sess-123");
		});
	});

	test("multiple emits append in order", () => {
		emitter.ready(1);
		emitter.pong("a");
		emitter.end("b");
		expect(captured).toHaveLength(3);
		const typed = captured as Array<{ type: string }>;
		expect(typed[0]?.type).toBe("ready");
		expect(typed[1]?.type).toBe("pong");
		expect(typed[2]?.type).toBe("end");
	});
});
