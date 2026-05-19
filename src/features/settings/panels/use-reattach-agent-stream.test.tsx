import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentReattachResponse,
	AgentStreamEvent,
	ReattachAgentStreamResult,
	ReattachedAgentEvent,
	ReleaseAgentStreamResult,
} from "@/lib/api";

const apiMocks = vi.hoisted(() => ({
	reattachRemoteAgentSessionStream: vi.fn(),
	releaseRemoteAgentStream: vi.fn(),
	startAgentReattachStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		reattachRemoteAgentSessionStream: apiMocks.reattachRemoteAgentSessionStream,
		releaseRemoteAgentStream: apiMocks.releaseRemoteAgentStream,
		startAgentReattachStream: apiMocks.startAgentReattachStream,
	};
});

import {
	useChatReattachStream,
	useReattachAgentStream,
} from "./use-reattach-agent-stream";

describe("useReattachAgentStream", () => {
	beforeEach(() => {
		apiMocks.reattachRemoteAgentSessionStream.mockReset();
		apiMocks.releaseRemoteAgentStream.mockReset();
		// Default: every reattach succeeds; every release succeeds.
		apiMocks.reattachRemoteAgentSessionStream.mockResolvedValue({
			found: true,
			lastSeq: 0,
			replayedCount: 0,
			replayGap: null,
		} satisfies ReattachAgentStreamResult);
		apiMocks.releaseRemoteAgentStream.mockResolvedValue({
			released: true,
		} satisfies ReleaseAgentStreamResult);
		// Silence the hook's console.warn branch.
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts in the idle phase with no events", () => {
		const { result } = renderHook(() => useReattachAgentStream());
		expect(result.current.phase).toBe("idle");
		expect(result.current.events).toEqual([]);
		expect(result.current.currentRequestId).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("transitions idle → attaching → streaming on a successful start", async () => {
		const { result } = renderHook(() => useReattachAgentStream());
		// The reattach mock resolves synchronously by default —
		// just await the start to flush all phases.
		await act(async () => {
			await result.current.start("dev.box", "req-1");
		});
		expect(result.current.phase).toBe("streaming");
		expect(result.current.currentRequestId).toBe("req-1");
		expect(apiMocks.reattachRemoteAgentSessionStream).toHaveBeenCalledWith(
			"dev.box",
			"req-1",
			expect.any(Function),
			undefined,
		);
	});

	it("forwards helmorSessionId + surfaces daemon replay diagnostics", async () => {
		// Phase 24q-2: the hook hands `helmorSessionId` through to
		// the API call (the backend computes `since_seq` from it)
		// and stashes the daemon-reported lastSeq / replayedCount /
		// replayGap on its state so the panel can render them.
		apiMocks.reattachRemoteAgentSessionStream.mockResolvedValueOnce({
			found: true,
			lastSeq: 99,
			replayedCount: 4,
			replayGap: 50,
		});
		const { result } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-resume", "hs-1");
		});
		expect(apiMocks.reattachRemoteAgentSessionStream).toHaveBeenCalledWith(
			"dev.box",
			"req-resume",
			expect.any(Function),
			"hs-1",
		);
		expect(result.current.lastSeq).toBe(99);
		expect(result.current.replayedCount).toBe(4);
		expect(result.current.replayGap).toBe(50);
	});

	it("captures events delivered through the runtime callback", async () => {
		// Grab the onEvent callback the hook passed to the API mock
		// so we can fire synthesised events ourselves.
		let onEvent: ((event: ReattachedAgentEvent) => void) | null = null;
		apiMocks.reattachRemoteAgentSessionStream.mockImplementation(
			async (_name: string, _requestId: string, cb: typeof onEvent) => {
				onEvent = cb;
				return { found: true, lastSeq: 0, replayedCount: 0, replayGap: null };
			},
		);

		const { result } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-1");
		});

		expect(onEvent).not.toBeNull();
		act(() => {
			onEvent?.({
				requestId: "req-1",
				event: { type: "assistant", delta: "hi" },
			});
			onEvent?.({
				requestId: "req-1",
				event: { type: "assistant", delta: " there" },
			});
		});
		expect(result.current.events).toHaveLength(2);
		expect(result.current.events[0].event.event).toEqual({
			type: "assistant",
			delta: "hi",
		});
	});

	it("surfaces notFound phase when the daemon reports the session is gone", async () => {
		apiMocks.reattachRemoteAgentSessionStream.mockResolvedValueOnce({
			found: false,
			lastSeq: 0,
			replayedCount: 0,
			replayGap: null,
		});
		const { result } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-stale");
		});
		expect(result.current.phase).toBe("notFound");
		// currentRequestId should clear — no stream is running.
		expect(result.current.currentRequestId).toBeNull();
	});

	it("surfaces error phase when the reattach RPC throws", async () => {
		apiMocks.reattachRemoteAgentSessionStream.mockRejectedValueOnce(
			new Error("runtime `dev.box` does not stream agent events"),
		);
		const { result } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-broken");
		});
		expect(result.current.phase).toBe("error");
		expect(result.current.error).toMatch(/does not stream agent events/);
		expect(result.current.currentRequestId).toBeNull();
	});

	it("stop() calls release + resets phase to idle", async () => {
		const { result } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-1");
		});
		await act(async () => {
			await result.current.stop();
		});
		expect(result.current.phase).toBe("idle");
		expect(result.current.currentRequestId).toBeNull();
		expect(apiMocks.releaseRemoteAgentStream).toHaveBeenCalledWith("req-1");
	});

	it("starting a second stream releases the first one's subscription", async () => {
		const { result } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-A");
		});
		// Switching to a new session should release req-A before
		// the new attach RPC fires.
		await act(async () => {
			await result.current.start("dev.box", "req-B");
		});
		// At least one release must have fired for req-A.
		const releaseCalls = apiMocks.releaseRemoteAgentStream.mock.calls;
		expect(releaseCalls.some((c) => c[0] === "req-A")).toBe(true);
		// Final state: streaming req-B.
		expect(result.current.currentRequestId).toBe("req-B");
		expect(result.current.phase).toBe("streaming");
	});

	it("clear() empties the events list without changing the phase", async () => {
		let onEvent: ((event: ReattachedAgentEvent) => void) | null = null;
		apiMocks.reattachRemoteAgentSessionStream.mockImplementation(
			async (_name: string, _requestId: string, cb: typeof onEvent) => {
				onEvent = cb;
				return { found: true, lastSeq: 0, replayedCount: 0, replayGap: null };
			},
		);
		const { result } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-1");
		});
		act(() => {
			onEvent?.({ requestId: "req-1", event: { delta: "x" } });
		});
		expect(result.current.events).toHaveLength(1);

		act(() => {
			result.current.clear();
		});
		expect(result.current.events).toHaveLength(0);
		// Streaming phase persists — clear is for the UI display.
		expect(result.current.phase).toBe("streaming");
	});

	it("releases the active subscription on unmount", async () => {
		const { result, unmount } = renderHook(() => useReattachAgentStream());
		await act(async () => {
			await result.current.start("dev.box", "req-unmount");
		});
		unmount();
		await waitFor(() => {
			expect(apiMocks.releaseRemoteAgentStream).toHaveBeenCalledWith(
				"req-unmount",
			);
		});
	});

	it("unmount with no active stream does not call release", () => {
		const { unmount } = renderHook(() => useReattachAgentStream());
		unmount();
		expect(apiMocks.releaseRemoteAgentStream).not.toHaveBeenCalled();
	});
});

describe("useChatReattachStream", () => {
	const baseArgs = {
		requestId: "req-chat-1",
		helmorSessionId: "sess-1",
		workspaceId: "ws-1",
		provider: "claude",
		modelId: "claude-opus-4-7",
		workingDirectory: "/tmp/cwd",
		fallbackResolvedModel: "claude-opus-4-7",
	};

	beforeEach(() => {
		apiMocks.startAgentReattachStream.mockReset();
		// Default: resolve immediately, no events delivered.
		apiMocks.startAgentReattachStream.mockResolvedValue({
			accepted: true,
		} satisfies AgentReattachResponse);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts in idle phase with no messages or partial", () => {
		const { result } = renderHook(() => useChatReattachStream());
		expect(result.current.phase).toBe("idle");
		expect(result.current.messages).toBeNull();
		expect(result.current.partial).toBeNull();
		expect(result.current.terminalLabel).toBeNull();
		expect(result.current.currentRequestId).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("transitions to streaming on a successful start", async () => {
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		expect(result.current.phase).toBe("streaming");
		expect(result.current.currentRequestId).toBe("req-chat-1");
		expect(apiMocks.startAgentReattachStream).toHaveBeenCalledWith(
			baseArgs,
			expect.any(Function),
		);
	});

	it("populates messages on an `update` event", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (_args: typeof baseArgs, cb: (event: AgentStreamEvent) => void) => {
				onEvent = cb;
				return { accepted: true };
			},
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		expect(onEvent).not.toBeNull();
		act(() => {
			onEvent?.({
				kind: "update",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", id: "t1", text: "hello" }],
					},
				],
			});
		});
		expect(result.current.messages).toHaveLength(1);
		expect(result.current.partial).toBeNull();
	});

	it("populates partial on `streamingPartial`, clears on next `update`", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (_args: typeof baseArgs, cb: (event: AgentStreamEvent) => void) => {
				onEvent = cb;
				return { accepted: true };
			},
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		act(() => {
			onEvent?.({
				kind: "streamingPartial",
				message: {
					role: "assistant",
					content: [{ type: "text", id: "t1", text: "stream..." }],
				},
			});
		});
		expect(result.current.partial).not.toBeNull();
		act(() => {
			onEvent?.({
				kind: "update",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", id: "t1", text: "stream done" }],
					},
				],
			});
		});
		expect(result.current.partial).toBeNull();
		expect(result.current.messages).toHaveLength(1);
	});

	it("sets terminalLabel + returns to idle on `done`", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (_args: typeof baseArgs, cb: (event: AgentStreamEvent) => void) => {
				onEvent = cb;
				return { accepted: true };
			},
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		act(() => {
			onEvent?.({
				kind: "done",
				provider: "claude",
				modelId: "claude-opus-4-7",
				resolvedModel: "claude-opus-4-7",
				sessionId: null,
				workingDirectory: "/tmp/cwd",
				persisted: false,
			});
		});
		expect(result.current.terminalLabel).toBe("Turn finished.");
		expect(result.current.phase).toBe("idle");
		expect(result.current.currentRequestId).toBeNull();
	});

	it("includes the reason in terminalLabel on `aborted`", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (_args: typeof baseArgs, cb: (event: AgentStreamEvent) => void) => {
				onEvent = cb;
				return { accepted: true };
			},
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		act(() => {
			onEvent?.({
				kind: "aborted",
				provider: "claude",
				modelId: "claude-opus-4-7",
				resolvedModel: "claude-opus-4-7",
				sessionId: null,
				workingDirectory: "/tmp/cwd",
				persisted: false,
				reason: "user pressed stop",
			});
		});
		expect(result.current.terminalLabel).toBe("Aborted: user pressed stop.");
		expect(result.current.phase).toBe("idle");
	});

	it("sets error + phase=error on `error` event", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (_args: typeof baseArgs, cb: (event: AgentStreamEvent) => void) => {
				onEvent = cb;
				return { accepted: true };
			},
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		act(() => {
			onEvent?.({
				kind: "error",
				message: "daemon crashed",
				persisted: false,
				internal: false,
			});
		});
		expect(result.current.error).toBe("daemon crashed");
		expect(result.current.terminalLabel).toBe("Error: daemon crashed");
		expect(result.current.phase).toBe("error");
		expect(result.current.currentRequestId).toBeNull();
	});

	it("surfaces error phase when the reattach RPC throws", async () => {
		apiMocks.startAgentReattachStream.mockRejectedValueOnce(
			new Error("transport closed"),
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		expect(result.current.phase).toBe("error");
		expect(result.current.error).toMatch(/transport closed/);
		expect(result.current.currentRequestId).toBeNull();
	});

	it("clear() empties messages/partial/terminalLabel/error", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (_args: typeof baseArgs, cb: (event: AgentStreamEvent) => void) => {
				onEvent = cb;
				return { accepted: true };
			},
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		act(() => {
			onEvent?.({
				kind: "update",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", id: "t1", text: "hi" }],
					},
				],
			});
			onEvent?.({
				kind: "streamingPartial",
				message: {
					role: "assistant",
					content: [{ type: "text", id: "t1", text: "..." }],
				},
			});
		});
		expect(result.current.messages).toHaveLength(1);
		expect(result.current.partial).not.toBeNull();
		act(() => {
			result.current.clear();
		});
		expect(result.current.messages).toBeNull();
		expect(result.current.partial).toBeNull();
		expect(result.current.terminalLabel).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it("stop() resets phase to idle and clears currentRequestId", async () => {
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		expect(result.current.phase).toBe("streaming");
		await act(async () => {
			await result.current.stop();
		});
		expect(result.current.phase).toBe("idle");
		expect(result.current.currentRequestId).toBeNull();
	});

	it("ignores events delivered after stop() (request id no longer matches)", async () => {
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (_args: typeof baseArgs, cb: (event: AgentStreamEvent) => void) => {
				onEvent = cb;
				return { accepted: true };
			},
		);
		const { result } = renderHook(() => useChatReattachStream());
		await act(async () => {
			await result.current.start(baseArgs);
		});
		await act(async () => {
			await result.current.stop();
		});
		// A late event from the abandoned subscription must not
		// resurrect state on an idle hook.
		act(() => {
			onEvent?.({
				kind: "update",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", id: "t1", text: "late" }],
					},
				],
			});
		});
		expect(result.current.messages).toBeNull();
		expect(result.current.phase).toBe("idle");
	});
});
