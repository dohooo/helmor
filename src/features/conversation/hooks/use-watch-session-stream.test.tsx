import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetStreamingStoreForTests,
	useStreamingStore,
} from "@/features/conversation/state/streaming-store";
import type { ActiveStreamSummary, AgentStreamEvent } from "@/lib/api";
import { useWatchSessionStream } from "./use-watch-session-stream";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const apiMocks = vi.hoisted(() => ({
	loadSessionThreadMessages: vi.fn(),
	subscribeSessionStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		loadSessionThreadMessages: apiMocks.loadSessionThreadMessages,
		subscribeSessionStream: apiMocks.subscribeSessionStream,
	};
});

const teamModeMocks = vi.hoisted(() => ({
	isTeamModeActive: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/team-mode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/team-mode")>();
	return {
		...actual,
		isTeamModeActive: teamModeMocks.isTeamModeActive,
	};
});

vi.mock("@/features/team/use-team-identity", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/features/team/use-team-identity")>();
	return {
		...actual,
		useTeamIdentity: () => ({ identity: null, isLoading: false }),
	};
});

const cacheMocks = vi.hoisted(() => ({
	readSessionThread: vi.fn().mockReturnValue([]),
	replaceStreamingTail: vi.fn(),
	mergeRoomChatMessages: vi.fn(),
}));

// session-thread-cache — don't exercise cache logic in this suite
vi.mock("@/lib/session-thread-cache", () => ({
	readSessionThread: cacheMocks.readSessionThread,
	replaceStreamingTail: cacheMocks.replaceStreamingTail,
	mergeRoomChatMessages: cacheMocks.mergeRoomChatMessages,
	sessionThreadCacheKey: (id: string) => ["sessionThread", id],
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_ACTIVE_STREAMS: readonly ActiveStreamSummary[] = [];

function activeStreamFor(sessionId: string): readonly ActiveStreamSummary[] {
	return [{ sessionId, workspaceId: null, provider: "claude" }];
}

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	}

	return { Wrapper, queryClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useWatchSessionStream — enabled gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetStreamingStoreForTests();
		// subscribeSessionStream returns a cleanup fn; default to a promise that
		// never resolves so we don't get unhandled-rejection noise.
		apiMocks.subscribeSessionStream.mockReturnValue(new Promise(() => {}));
		apiMocks.loadSessionThreadMessages.mockResolvedValue([]);
		teamModeMocks.isTeamModeActive.mockReturnValue(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does NOT subscribe when sessionId is null", () => {
		const { Wrapper } = createWrapper();
		renderHook(
			() =>
				useWatchSessionStream({
					sessionId: null,
					activeStreams: NO_ACTIVE_STREAMS,
				}),
			{ wrapper: Wrapper },
		);
		expect(apiMocks.subscribeSessionStream).not.toHaveBeenCalled();
	});

	it("does NOT subscribe for single-user with no remote stream (byte-identical path)", () => {
		// Single-user: isTeamModeActive = false, no active stream → enabled = false
		teamModeMocks.isTeamModeActive.mockReturnValue(false);
		const { Wrapper } = createWrapper();

		renderHook(
			() =>
				useWatchSessionStream({
					sessionId: "session-1",
					activeStreams: NO_ACTIVE_STREAMS,
				}),
			{ wrapper: Wrapper },
		);

		expect(apiMocks.subscribeSessionStream).not.toHaveBeenCalled();
	});

	it("subscribes when a remote stream is present regardless of team mode", () => {
		// Remote stream present → enabled = true even in single-user mode
		teamModeMocks.isTeamModeActive.mockReturnValue(false);
		const { Wrapper } = createWrapper();

		renderHook(
			() =>
				useWatchSessionStream({
					sessionId: "session-2",
					activeStreams: activeStreamFor("session-2"),
				}),
			{ wrapper: Wrapper },
		);

		expect(apiMocks.subscribeSessionStream).toHaveBeenCalledWith(
			"session-2",
			expect.any(Function),
		);
	});

	it("subscribes in team mode even when there is NO remote stream (idle-subscribe case)", () => {
		// Team mode + no active stream → enabled = true via isTeamModeActive()
		teamModeMocks.isTeamModeActive.mockReturnValue(true);
		const { Wrapper } = createWrapper();

		renderHook(
			() =>
				useWatchSessionStream({
					sessionId: "session-3",
					activeStreams: NO_ACTIVE_STREAMS,
				}),
			{ wrapper: Wrapper },
		);

		expect(apiMocks.subscribeSessionStream).toHaveBeenCalledWith(
			"session-3",
			expect.any(Function),
		);
	});

	it("does NOT subscribe when the sender is this client (isLocallyDriven suppresses)", () => {
		// isLocallyDriven is derived from the streaming store; mark this context
		// as "sending" so the guard fires.
		const { Wrapper } = createWrapper();

		// Put the store into "sending" state for session-4's context key before
		// the hook renders.
		useStreamingStore.getState().markSendingState("session:session-4");

		teamModeMocks.isTeamModeActive.mockReturnValue(true);

		renderHook(
			() =>
				useWatchSessionStream({
					sessionId: "session-4",
					// Even with a remote stream present, locally-driven must suppress
					activeStreams: activeStreamFor("session-4"),
				}),
			{ wrapper: Wrapper },
		);

		expect(apiMocks.subscribeSessionStream).not.toHaveBeenCalled();
	});

	it("routes room-chat broadcasts through id-based cache merge", () => {
		teamModeMocks.isTeamModeActive.mockReturnValue(true);
		const captured: { onEvent?: (event: AgentStreamEvent) => void } = {};
		apiMocks.subscribeSessionStream.mockImplementation(
			(_sessionId, callback) => {
				captured.onEvent = callback;
				return Promise.resolve(() => {});
			},
		);
		const { Wrapper } = createWrapper();

		renderHook(
			() =>
				useWatchSessionStream({
					sessionId: "session-5",
					activeStreams: NO_ACTIVE_STREAMS,
				}),
			{ wrapper: Wrapper },
		);

		const onEvent = captured.onEvent;
		expect(typeof onEvent).toBe("function");
		if (!onEvent) throw new Error("subscription callback was not captured");
		const messages = [
			{
				id: "room-1",
				role: "user" as const,
				createdAt: "2026-04-08T00:00:00Z",
				content: [{ type: "text" as const, id: "room-1:txt:0", text: "hi" }],
				isRoomChat: true,
				author: { id: "32405058" },
			},
		];
		onEvent({ kind: "update", messages });

		expect(cacheMocks.mergeRoomChatMessages).toHaveBeenCalledWith(
			expect.any(QueryClient),
			"session-5",
			messages,
		);
		expect(cacheMocks.replaceStreamingTail).not.toHaveBeenCalled();
	});

	it("marks mirrored remote turns active until the terminal event arrives", async () => {
		teamModeMocks.isTeamModeActive.mockReturnValue(true);
		const captured: { onEvent?: (event: AgentStreamEvent) => void } = {};
		apiMocks.subscribeSessionStream.mockImplementation(
			(_sessionId, callback) => {
				captured.onEvent = callback;
				return Promise.resolve(() => {});
			},
		);
		const { Wrapper } = createWrapper();

		renderHook(
			() =>
				useWatchSessionStream({
					sessionId: "session-6",
					activeStreams: NO_ACTIVE_STREAMS,
				}),
			{ wrapper: Wrapper },
		);

		const onEvent = captured.onEvent;
		expect(typeof onEvent).toBe("function");
		if (!onEvent) throw new Error("subscription callback was not captured");
		await act(async () => {
			onEvent({
				kind: "update",
				messages: [
					{
						id: "assistant-1",
						role: "assistant",
						createdAt: "2026-04-08T00:00:00Z",
						content: [
							{
								type: "text" as const,
								id: "assistant-1:txt:0",
								text: "hi",
							},
						],
					},
				],
			});
			await Promise.resolve();
		});
		expect(
			useStreamingStore.getState().mirroredActiveSessionByContext[
				"session:session-6"
			],
		).toBe("session-6");

		onEvent({
			kind: "done",
			provider: "claude",
			modelId: "opus",
			resolvedModel: "opus",
			sessionId: null,
			workingDirectory: "/tmp/helmor",
			persisted: true,
		});
		expect(
			useStreamingStore.getState().mirroredActiveSessionByContext[
				"session:session-6"
			],
		).toBeUndefined();
	});
});
