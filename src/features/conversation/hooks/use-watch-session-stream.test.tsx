import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetStreamingStoreForTests,
	useStreamingStore,
} from "@/features/conversation/state/streaming-store";
import type { ActiveStreamSummary } from "@/lib/api";
import { useWatchSessionStream } from "./use-watch-session-stream";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const apiMocks = vi.hoisted(() => ({
	subscribeSessionStream: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
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

// session-thread-cache — don't exercise cache logic in this suite
vi.mock("@/lib/session-thread-cache", () => ({
	readSessionThread: vi.fn().mockReturnValue([]),
	replaceStreamingTail: vi.fn(),
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
});
