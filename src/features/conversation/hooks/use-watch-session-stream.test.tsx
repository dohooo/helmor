import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetStreamingStoreForTests,
	useStreamingStore,
} from "@/features/conversation/state/streaming-store";
import type {
	ActiveStreamSummary,
	AgentStreamEvent,
	ThreadMessageLike,
} from "@/lib/api";
import { readSessionThread } from "@/lib/session-thread-cache";
import { useWatchSessionStream } from "./use-watch-session-stream";

const apiMocks = vi.hoisted(() => ({
	subscribeSessionStream: vi.fn(),
	loadSessionThreadMessages: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		subscribeSessionStream: apiMocks.subscribeSessionStream,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
	};
});

const SESSION_ID = "s1";

/** A persisted user prompt — the splice boundary `refreshFromDb` must surface. */
const USER_BOUNDARY: ThreadMessageLike = {
	role: "user",
	id: "user-1",
	content: [{ type: "text", id: "user-1-text", text: "hi" }],
};

const activeStream: ActiveStreamSummary = {
	sessionId: SESSION_ID,
	workspaceId: "w1",
	provider: "codex",
};

function updateFrame(text: string): AgentStreamEvent {
	return {
		kind: "update",
		messages: [
			{
				role: "assistant",
				id: "assistant-1",
				content: [{ type: "text", id: "assistant-1-text", text }],
			},
		],
	};
}

const doneFrame: AgentStreamEvent = {
	kind: "done",
	provider: "codex",
	modelId: "gpt-5.4",
	resolvedModel: "gpt-5.4",
	workingDirectory: "/tmp",
	persisted: true,
};

let queryClient: QueryClient;
let cleanup: ReturnType<typeof vi.fn>;
let emit: ((event: AgentStreamEvent) => void) | null;

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	__resetStreamingStoreForTests();
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cleanup = vi.fn();
	emit = null;
	apiMocks.subscribeSessionStream.mockReset();
	apiMocks.loadSessionThreadMessages.mockReset();
	apiMocks.loadSessionThreadMessages.mockResolvedValue([USER_BOUNDARY]);
	apiMocks.subscribeSessionStream.mockImplementation(
		async (_sessionId: string, callback: (e: AgentStreamEvent) => void) => {
			emit = callback;
			return cleanup;
		},
	);
	// Run rAF-scheduled flushes synchronously so cache writes are observable.
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
		cb(0);
		return 0;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useWatchSessionStream", () => {
	it("subscribes and refreshes from DB on mount when a remote stream exists", async () => {
		const { unmount } = renderHook(
			() =>
				useWatchSessionStream({
					sessionId: SESSION_ID,
					activeStreams: [activeStream],
				}),
			{ wrapper },
		);

		await waitFor(() => {
			expect(apiMocks.subscribeSessionStream).toHaveBeenCalledTimes(1);
		});
		expect(apiMocks.subscribeSessionStream).toHaveBeenCalledWith(
			SESSION_ID,
			expect.any(Function),
		);
		// Mount-time refreshFromDb surfaces the just-sent user prompt.
		await waitFor(() => {
			expect(apiMocks.loadSessionThreadMessages).toHaveBeenCalledWith(
				SESSION_ID,
			);
		});
		unmount();
	});

	it("flushes a replayed update frame into the thread cache after the boundary refetch", async () => {
		const { unmount } = renderHook(
			() =>
				useWatchSessionStream({
					sessionId: SESSION_ID,
					activeStreams: [activeStream],
				}),
			{ wrapper },
		);

		await waitFor(() => expect(emit).not.toBeNull());
		// First render frame triggers the boundary refetch, then drains + flushes.
		emit?.(updateFrame("streamed answer"));

		await waitFor(() => {
			const thread = readSessionThread(queryClient, SESSION_ID);
			expect(thread?.some((m) => m.id === "assistant-1")).toBe(true);
		});
		const thread = readSessionThread(queryClient, SESSION_ID);
		// Boundary user message stays spliced in front of the streamed turn.
		expect(thread?.[0]?.id).toBe("user-1");
		unmount();
	});

	it("reconciles from DB on a done frame", async () => {
		const { unmount } = renderHook(
			() =>
				useWatchSessionStream({
					sessionId: SESSION_ID,
					activeStreams: [activeStream],
				}),
			{ wrapper },
		);

		await waitFor(() => expect(emit).not.toBeNull());
		// A render frame first flips `boundaryReady` (and runs its own
		// boundary refetch); the subsequent `done` is the reconcile we assert.
		emit?.(updateFrame("partial"));
		await waitFor(() => {
			const thread = readSessionThread(queryClient, SESSION_ID);
			expect(thread?.some((m) => m.id === "assistant-1")).toBe(true);
		});

		apiMocks.loadSessionThreadMessages.mockClear();
		emit?.(doneFrame);

		await waitFor(() => {
			expect(apiMocks.loadSessionThreadMessages).toHaveBeenCalledWith(
				SESSION_ID,
			);
		});
		unmount();
	});

	it("does not subscribe when the session is locally driven", async () => {
		useStreamingStore.getState().setActiveSession(`session:${SESSION_ID}`, {
			stopSessionId: SESSION_ID,
			provider: "codex",
		});

		// Clear right before the render so the assertion is immune to any
		// residual async subscribe from a prior test's teardown.
		apiMocks.subscribeSessionStream.mockClear();
		const { unmount } = renderHook(
			() =>
				useWatchSessionStream({
					sessionId: SESSION_ID,
					activeStreams: [activeStream],
				}),
			{ wrapper },
		);

		// Give any (incorrect) effect a chance to fire.
		await Promise.resolve();
		expect(apiMocks.subscribeSessionStream).not.toHaveBeenCalled();
		unmount();
	});

	it("does not subscribe when no remote stream is active", async () => {
		apiMocks.subscribeSessionStream.mockClear();
		const { unmount } = renderHook(
			() => useWatchSessionStream({ sessionId: SESSION_ID, activeStreams: [] }),
			{ wrapper },
		);

		await Promise.resolve();
		expect(apiMocks.subscribeSessionStream).not.toHaveBeenCalled();
		unmount();
	});
});
