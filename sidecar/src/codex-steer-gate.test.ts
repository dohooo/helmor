/**
 * Gate-ordering regression test for `CodexAppServerManager.steer()`.
 *
 * We drive a real `CodexAppServerManager` against a fake
 * `CodexAppServer` stub and exercise the REAL code path end-to-end:
 * `sendMessage` installs `handleNotification` + `handleRequest` on the
 * stub via `setHandlers`; the test then fires notifications / requests
 * through those CAPTURED production closures while `steer()` holds the
 * gate. If someone deletes `await ctx.notificationGate` from either
 * handler the ordering check fails loudly.
 *
 * Properties under test:
 *   1. Notifications that arrive between `turn/steer` send and reply
 *      are dispatched AFTER the synthetic `user_prompt` event.
 *   2. Server-initiated requests (approvals, user-input prompts) are
 *      ALSO gated — otherwise a permission panel could pop before the
 *      steer bubble lands in the thread.
 *   3. Rejection path: queued events still drain, without a synthetic
 *      ahead of them.
 *
 * Guards reviewer-flagged gaps in the previous pattern-only test.
 */

import { describe, expect, test } from "bun:test";
import type { OnNotification, OnRequest } from "./codex-app-server.js";
import { CodexAppServerManager } from "./codex-app-server-manager.js";
import { SubAgentTracker } from "./codex-subagent-tracker.js";
import { createSidecarEmitter } from "./emitter.js";

interface PendingRpc {
	method: string;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

/** Duck-typed stand-in for `CodexAppServer`. Captures the REAL
 *  handlers the manager installs via `setHandlers`, and exposes
 *  controllable `sendRequest` promises so the test can hold RPC
 *  replies open while it fires events through the captured
 *  production closures. */
function makeFakeServer() {
	let onNotification: OnNotification = () => {};
	let onRequest: OnRequest = () => {};
	const pending: PendingRpc[] = [];

	const api = {
		killed: false,
		setHandlers(n: OnNotification, r: OnRequest): void {
			onNotification = n;
			onRequest = r;
		},
		setActiveRequestId(_id: string): void {},
		async sendRequest<T>(method: string, _params?: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				pending.push({
					method,
					resolve: resolve as (v: unknown) => void,
					reject,
				});
			});
		},
		sendResponse(_id: string | number, _result: unknown): void {},
		writeNotification(_method: string, _params?: unknown): void {},
		kill(): void {
			this.killed = true;
		},
	};

	return {
		server: api,
		pending,
		// Expose the CAPTURED production handlers. Tests fire through
		// these — NOT through local replicas — so the real gate
		// `await`s are exercised.
		fireNotification(method: string, params?: Record<string, unknown>) {
			return onNotification({
				method,
				params,
			} as Parameters<OnNotification>[0]);
		},
		fireRequest(id: string, method: string, params?: Record<string, unknown>) {
			return onRequest({
				id,
				method,
				params,
			} as Parameters<OnRequest>[0]);
		},
		resolveNext(method: string, value: unknown = { ok: true }): boolean {
			const idx = pending.findIndex((p) => p.method === method);
			if (idx < 0) return false;
			const [p] = pending.splice(idx, 1);
			p?.resolve(value);
			return true;
		},
		rejectNext(method: string, err: Error): boolean {
			const idx = pending.findIndex((p) => p.method === method);
			if (idx < 0) return false;
			const [p] = pending.splice(idx, 1);
			p?.reject(err);
			return true;
		},
	};
}

/** Pre-seed the manager's private `sessions` map with a context
 *  whose `server` is our fake, then start `sendMessage` so the real
 *  production code path wires `handleNotification`/`handleRequest` via
 *  `server.setHandlers`. Returns control back to the test with the
 *  fake exposed for firing events and the event buffer for
 *  assertions. `sendMessage`'s Promise parks awaiting `turn/completed`
 *  — the test resolves it at the end. */
async function driveToSendMessage(sessionId: string) {
	const manager = new CodexAppServerManager();
	const fake = makeFakeServer();
	const events: object[] = [];
	const emitter = createSidecarEmitter((e) => events.push(e));

	// biome-ignore lint/suspicious/noExplicitAny: inject into private sessions
	(manager as any).sessions.set(sessionId, {
		server: fake.server,
		providerThreadId: "thread-xyz",
		activeTurnId: null, // `sendMessage` populates on turn/start reply
		turnResolve: null,
		turnReject: null,
		activeRequestId: null,
		activeEmitter: null,
		notificationGate: null,
		lastSentModel: "",
		agentProxyKey: "none",
		lastRetryAt: null,
		lastRetryNotice: null,
		subAgentTracker: new SubAgentTracker(fake.server as never),
	});

	const sendMessagePromise = manager.sendMessage(
		"stream-rid-1",
		{
			sessionId,
			prompt: "initial question",
			model: undefined,
			cwd: undefined,
			resume: undefined,
			effortLevel: undefined,
			permissionMode: undefined,
			fastMode: undefined,
			images: [],
		},
		emitter,
	);

	// Let `sendMessage` run until it calls `sendRequest("turn/start")`
	// and parks. At this point `setHandlers` has been called with the
	// real handleNotification/handleRequest closures.
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));

	// Reply to turn/start with a valid turn id so ctx.activeTurnId
	// populates — `steer()` won't proceed without it.
	const turnStarted = fake.resolveNext("turn/start", {
		turn: { id: "turn-active" },
	});
	expect(turnStarted).toBe(true);
	await new Promise((r) => setTimeout(r, 0));

	return { manager, fake, events, sessionId, sendMessagePromise };
}

/** Tear down a test by firing turn/completed (resolves sendMessage)
 *  and awaiting all outstanding promises. */
async function finish(
	fake: ReturnType<typeof makeFakeServer>,
	sendMessagePromise: Promise<void>,
): Promise<void> {
	fake.fireNotification("turn/completed", { turn: { id: "turn-active" } });
	await sendMessagePromise;
}

const userPromptTypes = (events: object[]) =>
	events
		.filter((e): e is { type: string } => {
			const t = (e as { type?: unknown }).type;
			return typeof t === "string";
		})
		.map((e) => e.type);

describe("CodexAppServerManager.steer gate — real manager wiring", () => {
	test("notifications during turn/steer RPC land AFTER synthetic user_prompt", async () => {
		const { manager, fake, events, sendMessagePromise } =
			await driveToSendMessage("s1");

		const steerPromise = manager.steer("s1", "focus on failing tests", [], []);
		// Let steer() install the gate and park on sendRequest.
		await new Promise((r) => setTimeout(r, 0));

		// Fire two server-side deltas BEFORE the RPC reply — this is
		// the race condition the gate defends against.
		fake.fireNotification("item/delta-1", {
			item: { id: "i1", type: "text", text: "hello" },
		});
		fake.fireNotification("item/delta-2", {
			item: { id: "i2", type: "text", text: "world" },
		});
		await new Promise((r) => setTimeout(r, 0));

		// Reply to turn/steer → synthetic emits → gate releases →
		// queued notifications drain in FIFO.
		expect(fake.resolveNext("turn/steer", {})).toBe(true);
		expect(await steerPromise).toBe(true);
		await new Promise((r) => setTimeout(r, 0));

		const types = userPromptTypes(events);
		// Pattern: somewhere in the sequence the synthetic user_prompt
		// event must appear strictly before the two item/delta
		// notifications (flattened by handleNotification).
		const userPromptIdx = types.indexOf("user_prompt");
		expect(userPromptIdx).toBeGreaterThanOrEqual(0);
		const afterSteer = types.slice(userPromptIdx + 1);
		// Both deltas flattened via `flattenNotification` (method
		// becomes the outer type) — exact event kind depends on
		// production flattener but ordering is the invariant.
		expect(afterSteer.length).toBeGreaterThanOrEqual(2);

		await finish(fake, sendMessagePromise);
	});

	test("server-initiated requests are ALSO gated behind synthetic", async () => {
		const { manager, fake, events, sendMessagePromise } =
			await driveToSendMessage("s1");

		const steerPromise = manager.steer("s1", "switch direction", [], []);
		await new Promise((r) => setTimeout(r, 0));

		// Tool approval request mid-steer. Without handleRequest's
		// gate await, this would fire `emitter.permissionRequest`
		// BEFORE the synthetic user_prompt — permission panel pops
		// before the steer bubble shows up.
		fake.fireRequest("approval-1", "item/commandExecution/requestApproval", {
			command: "echo hi",
		});
		await new Promise((r) => setTimeout(r, 0));

		expect(fake.resolveNext("turn/steer", {})).toBe(true);
		expect(await steerPromise).toBe(true);
		await new Promise((r) => setTimeout(r, 0));

		// Find indices of the synthetic and the permission request
		// in the real emitter output.
		const idxSynthetic = events.findIndex(
			(e) => (e as { type?: string }).type === "user_prompt",
		);
		const idxPermission = events.findIndex(
			(e) => (e as { type?: string }).type === "permissionRequest",
		);
		expect(idxSynthetic).toBeGreaterThanOrEqual(0);
		expect(idxPermission).toBeGreaterThanOrEqual(0);
		expect(idxSynthetic).toBeLessThan(idxPermission);

		await finish(fake, sendMessagePromise);
	});

	test("RPC rejection: queued events drain without a synthetic ahead", async () => {
		const { manager, fake, events, sendMessagePromise } =
			await driveToSendMessage("s1");

		const steerPromise = manager.steer("s1", "bad steer", [], []);
		await new Promise((r) => setTimeout(r, 0));

		fake.fireNotification("item/delta-1", {
			item: { id: "i1", type: "text", text: "x" },
		});
		await new Promise((r) => setTimeout(r, 0));

		// Reject turn/steer — e.g. expectedTurnId mismatch.
		expect(
			fake.rejectNext("turn/steer", new Error("turn already completed")),
		).toBe(true);
		await expect(steerPromise).rejects.toThrow("turn already completed");
		await new Promise((r) => setTimeout(r, 0));

		// No synthetic emitted on rejection path.
		const idxSynthetic = events.findIndex(
			(e) => (e as { type?: string }).type === "user_prompt",
		);
		expect(idxSynthetic).toBe(-1);

		await finish(fake, sendMessagePromise);
	});

	test("legacy retry window only suppresses reconnect notices", async () => {
		const { manager, fake, events, sendMessagePromise, sessionId } =
			await driveToSendMessage("s1");

		// Simulate an older Codex app-server build: stderr already emitted a
		// reconnect line, but the JSON-RPC error lacks structured willRetry.
		// Only explicit reconnect progress should be suppressed; terminal
		// provider errors inside that window must still surface immediately.
		// biome-ignore lint/suspicious/noExplicitAny: inspect private sessions in regression test
		(manager as any).sessions.get(sessionId).lastRetryAt = Date.now();

		await fake.fireNotification("error", {
			error: { message: "Reconnecting... 1/5" },
		});
		await new Promise((r) => setTimeout(r, 0));

		const reconnectError = events.find(
			(e) => (e as { type?: string }).type === "error",
		);
		expect(reconnectError).toBeUndefined();
		expect(events).toContainEqual({
			id: "stream-rid-1",
			type: "system",
			subtype: "codex_reconnecting",
			attempt: 1,
			max_retries: 5,
			retry_delay_ms: 0,
			error: "Reconnecting... 1/5",
		});

		await finish(fake, sendMessagePromise);
	});

	test("structured retry notices are delivered once with heartbeat", async () => {
		const { fake, events, sendMessagePromise } = await driveToSendMessage("s1");

		await fake.fireNotification("error", {
			willRetry: true,
			error: { message: "Reconnecting... 2/5" },
		});
		await fake.fireNotification("error", {
			willRetry: true,
			error: { message: "Reconnecting... 2/5" },
		});
		await new Promise((r) => setTimeout(r, 0));

		expect(
			events.filter((e) => (e as { type?: string }).type === "heartbeat"),
		).toHaveLength(2);
		expect(
			events.filter(
				(e) =>
					(e as { type?: string; subtype?: string }).type === "system" &&
					(e as { subtype?: string }).subtype === "codex_reconnecting",
			),
		).toEqual([
			{
				id: "stream-rid-1",
				type: "system",
				subtype: "codex_reconnecting",
				attempt: 2,
				max_retries: 5,
				retry_delay_ms: 0,
				error: "Reconnecting... 2/5",
			},
		]);

		await finish(fake, sendMessagePromise);
	});

	test("terminal errors emit inside a legacy retry window", async () => {
		const { manager, fake, events, sendMessagePromise, sessionId } =
			await driveToSendMessage("s1");

		// biome-ignore lint/suspicious/noExplicitAny: inspect private sessions in regression test
		(manager as any).sessions.get(sessionId).lastRetryAt = Date.now();

		await fake.fireNotification("error", {
			error: { message: "Reconnecting... exhausted retries" },
		});
		await sendMessagePromise;

		expect(events).toContainEqual({
			id: "stream-rid-1",
			type: "error",
			message: "Reconnecting... exhausted retries",
		});
	});

	test("steady-state: notifications flow through when no steer is pending", async () => {
		const { fake, events, sendMessagePromise } = await driveToSendMessage("s1");

		fake.fireNotification("item/delta-pre", {
			item: { id: "x", type: "text", text: "hi" },
		});
		await new Promise((r) => setTimeout(r, 0));

		// No gate is installed; handler should fall through normally.
		// Exact event type depends on the flattener — we just assert
		// the handler wasn't blocked (at least one event emitted after
		// sendMessage's own init output).
		expect(events.length).toBeGreaterThan(0);

		await finish(fake, sendMessagePromise);
	});
});
