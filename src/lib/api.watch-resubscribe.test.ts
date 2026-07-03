import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCompanionIdleSuspended } from "./companion-suspend";
import * as ipc from "./ipc";
import * as teamReadiness from "./team-readiness";

// Keep the real Channel; stub the transport calls (same pattern as
// api.agent-stream.test.ts).
vi.mock("./ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ipc")>()),
	invoke: vi.fn(),
	closeChannel: vi.fn(),
}));
vi.mock("./team-readiness", async (importOriginal) => ({
	...(await importOriginal<typeof import("./team-readiness")>()),
	getTeamReadiness: vi.fn(),
}));

import { type AgentStreamEvent, subscribeSessionStream } from "./api";

type StreamChannel = { onmessage?: (event: AgentStreamEvent) => void };
type SubscribeCall = { subscriptionId: string; channel: StreamChannel };

/** Capture every subscribe_session_stream invoke so tests can drive the
 *  channel (deliver events / the internal watchClosed marker). */
function captureSubscribes(): SubscribeCall[] {
	const calls: SubscribeCall[] = [];
	vi.mocked(ipc.invoke).mockImplementation(((
		cmd: string,
		args?: Record<string, unknown>,
	) => {
		if (cmd === "subscribe_session_stream") {
			calls.push({
				subscriptionId: args?.subscriptionId as string,
				channel: args?.onEvent as StreamChannel,
			});
		}
		return Promise.resolve(undefined);
	}) as unknown as typeof ipc.invoke);
	return calls;
}

const watchClosed = { kind: "watchClosed" } as unknown as AgentStreamEvent;

function mockReadiness(state: string) {
	vi.mocked(teamReadiness.getTeamReadiness).mockReturnValue({
		state,
	} as ReturnType<typeof teamReadiness.getTeamReadiness>);
}

describe("subscribeSessionStream auto-resubscribe (R2-A)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockReadiness("ready");
		setCompanionIdleSuspended(false);
	});
	afterEach(() => {
		setCompanionIdleSuspended(false);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("resubscribes with backoff after a silent close, without leaking watchClosed to the caller", async () => {
		const calls = captureSubscribes();
		const callback = vi.fn();
		const unlisten = await subscribeSessionStream("s1", callback);
		expect(calls).toHaveLength(1);

		calls[0].channel.onmessage?.(watchClosed);
		expect(callback).not.toHaveBeenCalled();
		// Backoff: first retry at 1s.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(2);
		expect(calls[1].subscriptionId).not.toBe(calls[0].subscriptionId);

		// Second silent death → next retry backs off to 2s.
		calls[1].channel.onmessage?.(watchClosed);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(3);

		// Healthy traffic resets the ladder back to 1s.
		calls[2].channel.onmessage?.({ kind: "update", messages: [] });
		expect(callback).toHaveBeenCalledWith({ kind: "update", messages: [] });
		calls[2].channel.onmessage?.(watchClosed);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(4);
		unlisten();
	});

	it("no events are lost across a server-side lifetime rotation (R2-A.1)", async () => {
		// The container rotates subscription bodies every ~5m (zombie-pipe
		// reaper). Rotation presents to the client as a silent close →
		// resubscribe; events emitted after reattach flow to the SAME callback.
		// The sub-second gap itself is covered by the watch hook's
		// reconcile-on-attach (`refreshFromDb`) + the WP3 merge rules, so
		// nothing observable is dropped.
		const calls = captureSubscribes();
		const callback = vi.fn();
		const unlisten = await subscribeSessionStream("s1", callback);

		calls[0].channel.onmessage?.({ kind: "update", messages: [] });
		calls[0].channel.onmessage?.(watchClosed); // ← lifetime rotation
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(2);
		calls[1].channel.onmessage?.({ kind: "planCaptured" });

		expect(callback).toHaveBeenNthCalledWith(1, {
			kind: "update",
			messages: [],
		});
		expect(callback).toHaveBeenNthCalledWith(2, { kind: "planCaptured" });
		expect(callback).toHaveBeenCalledTimes(2); // watchClosed never leaked
		unlisten();
	});

	it("unlisten stops the resubscribe loop and unsubscribes", async () => {
		const calls = captureSubscribes();
		const unlisten = await subscribeSessionStream("s1", vi.fn());
		calls[0].channel.onmessage?.(watchClosed);

		unlisten();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(calls).toHaveLength(1);
		expect(ipc.invoke).toHaveBeenCalledWith("unsubscribe_session_stream", {
			sessionId: "s1",
			subscriptionId: calls[0].subscriptionId,
		});
	});

	it("does not knock while team readiness is degraded, resumes once ready", async () => {
		const calls = captureSubscribes();
		const unlisten = await subscribeSessionStream("s1", vi.fn());
		mockReadiness("degraded");

		calls[0].channel.onmessage?.(watchClosed);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(calls).toHaveLength(1); // zero network attempts while degraded

		mockReadiness("ready");
		await vi.advanceTimersByTimeAsync(30_000); // ceiled backoff tick
		expect(calls).toHaveLength(2);
		unlisten();
	});

	it("idle-suspend detaches the watch; resume reattaches immediately", async () => {
		const calls = captureSubscribes();
		const unlisten = await subscribeSessionStream("s1", vi.fn());

		setCompanionIdleSuspended(true);
		// Detach aborts the companion fetch (no network unsubscribe that would
		// re-wake the sandbox).
		expect(ipc.closeChannel).toHaveBeenCalledTimes(1);
		expect(ipc.invoke).not.toHaveBeenCalledWith(
			"unsubscribe_session_stream",
			expect.anything(),
		);
		// While suspended, even a pending watchClosed retry must not reattach.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(calls).toHaveLength(1);

		setCompanionIdleSuspended(false);
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		unlisten();
	});
});
