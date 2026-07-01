import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSendRequest, AgentStreamEvent } from "./api";
import { startAgentMessageStream } from "./api";
import * as ipc from "./ipc";

// Keep the real Channel (so `new Channel()` resolves to the in-jsdom companion
// channel); stub only the two transport calls the cold-start watchdog touches.
vi.mock("./ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ipc")>()),
	invoke: vi.fn(),
	closeChannel: vi.fn(),
}));

type StreamChannel = { onmessage?: (event: AgentStreamEvent) => void };

describe("startAgentMessageStream cold-start watchdog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Capture the Channel that startAgentMessageStream hands to invoke so a test
	// can simulate the stream emitting (or never emitting) events.
	function captureOnEvent(): () => StreamChannel | undefined {
		let onEvent: StreamChannel | undefined;
		vi.mocked(ipc.invoke).mockImplementation(((
			_cmd: string,
			args?: Record<string, unknown>,
		) => {
			onEvent = args?.onEvent as StreamChannel | undefined;
			return Promise.resolve(undefined);
		}) as unknown as typeof ipc.invoke);
		return () => onEvent;
	}

	it("synthesizes a terminal error if the stream never produces an event", async () => {
		captureOnEvent();
		const callback = vi.fn();
		await startAgentMessageStream({} as AgentSendRequest, callback);
		expect(callback).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(210_000);

		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "error" }),
		);
		expect(ipc.closeChannel).toHaveBeenCalledTimes(1);
	});

	it("never fires the watchdog once the first event has streamed in", async () => {
		const getOnEvent = captureOnEvent();
		const callback = vi.fn();
		await startAgentMessageStream({} as AgentSendRequest, callback);

		getOnEvent()?.onmessage?.({ kind: "update", messages: [] });
		await vi.advanceTimersByTimeAsync(210_000);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith({ kind: "update", messages: [] });
		expect(ipc.closeChannel).not.toHaveBeenCalled();
	});
});
