// R3-A lock: a watch stream that hits a typed asleep must NOT hot-reconnect —
// it jumps straight to the slow 60s cadence (the "resubscribe wake-loop"
// failure mode the wake-intent gate exists to prevent). Prompt re-attach on a
// real turn comes from TeamHub's turn-started signal, not from polling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionAsleepError } from "./companion-asleep";

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("./ipc", async (importOriginal) => {
	const original = await importOriginal<typeof import("./ipc")>();
	return {
		...original,
		invoke: (...args: unknown[]) => invokeMock(...args),
	};
});
vi.mock("./companion-suspend", () => ({
	isCompanionIdleSuspended: () => false,
}));
vi.mock("./team-readiness", () => ({
	getTeamReadiness: () => ({ state: "ready" }),
}));

import { subscribeSessionStream } from "./api";

type WatchChannel = { onmessage: ((event: unknown) => void) | null };

describe("subscribeSessionStream asleep backoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		invokeMock.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("jumps to the 60s cadence after a typed asleep instead of laddering", async () => {
		let channel = null as WatchChannel | null;
		const attachCalls = () =>
			invokeMock.mock.calls.filter(
				(call) => call[0] === "subscribe_session_stream",
			).length;

		// First attach succeeds; capture the channel to drive watchClosed.
		invokeMock.mockImplementation(async (cmd, args) => {
			if (cmd === "subscribe_session_stream") {
				channel = (args as { onEvent: WatchChannel }).onEvent;
			}
			return undefined;
		});
		const unlisten = await subscribeSessionStream("session-1", () => {});
		expect(attachCalls()).toBe(1);

		// From now on, every attach finds the sandbox asleep.
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === "subscribe_session_stream") {
				throw new CompanionAsleepError();
			}
			return undefined;
		});

		// The pipe dies (asleep-settled) → resubscribe scheduled at the 1s base.
		channel?.onmessage?.({ kind: "watchClosed" });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(attachCalls()).toBe(2); // the retry that discovers asleep

		// LOCK: after the typed asleep, NO further attach for the next 59.9s…
		await vi.advanceTimersByTimeAsync(59_900);
		expect(attachCalls()).toBe(2);
		// …and the next probe lands on the slow 60s cadence.
		await vi.advanceTimersByTimeAsync(200);
		expect(attachCalls()).toBe(3);

		// Still asleep → the cadence STAYS at 60s (no tightening back down).
		await vi.advanceTimersByTimeAsync(30_000);
		expect(attachCalls()).toBe(3);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(attachCalls()).toBe(4);

		unlisten();
	});

	it("keeps the fast ladder for non-asleep failures", async () => {
		invokeMock.mockImplementation(async (cmd) => {
			if (cmd === "subscribe_session_stream") {
				throw new Error("edge drop");
			}
			return undefined;
		});
		await expect(subscribeSessionStream("session-1", () => {})).rejects.toThrow(
			"edge drop",
		);
	});
});
