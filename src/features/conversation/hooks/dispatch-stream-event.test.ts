import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { sessionThreadCacheKey } from "@/lib/session-thread-cache";
import {
	createStreamEventDispatcher,
	createStreamFlushers,
	type StreamAccumulator,
	type StreamDispatchDeps,
} from "./dispatch-stream-event";

function userMessage(id: string): ThreadMessageLike {
	return {
		id,
		role: "user",
		content: [{ type: "text", id: `${id}:text`, text: "prompt" }],
	};
}

function assistantMessage(id: string, text: string): ThreadMessageLike {
	return {
		id,
		role: "assistant",
		streaming: true,
		content: [{ type: "text", id: `${id}:text`, text }],
	};
}

describe("createStreamFlushers", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("flushes through the fallback timer when requestAnimationFrame stalls", () => {
		vi.useFakeTimers();
		const queryClient = new QueryClient();
		const optimisticUserMessage = userMessage("u1");
		queryClient.setQueryData(sessionThreadCacheKey("session-1"), [
			optimisticUserMessage,
		]);
		const accumulator: StreamAccumulator = {
			baseMessages: [assistantMessage("a1", "hello")],
			pendingPartial: null,
			needsFlush: false,
			frameId: null,
			fallbackTimerId: null,
		};
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation(() => 42);
		const cancelSpy = vi
			.spyOn(window, "cancelAnimationFrame")
			.mockImplementation(() => {});
		const interval = window.setInterval(() => {}, 1_000);
		const { cleanup, scheduleFlush } = createStreamFlushers({
			accumulator,
			queryClient,
			cacheSessionId: "session-1",
			userMessageId: "u1",
			optimisticUserMessage,
			changesRefreshInterval: interval,
		});

		scheduleFlush();

		expect(rafSpy).toHaveBeenCalledTimes(1);
		expect(
			queryClient.getQueryData<ThreadMessageLike[]>(
				sessionThreadCacheKey("session-1"),
			),
		).toHaveLength(1);

		vi.advanceTimersByTime(120);

		const cached = queryClient.getQueryData<ThreadMessageLike[]>(
			sessionThreadCacheKey("session-1"),
		);
		expect(cached).toHaveLength(2);
		expect(cached?.[1]?.content[0]).toEqual(
			expect.objectContaining({ text: "hello" }),
		);
		expect(cancelSpy).toHaveBeenCalledWith(42);

		cleanup();
	});
});

describe("createStreamEventDispatcher", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops a stale pending partial on done so it never freezes into the cache", () => {
		const queryClient = new QueryClient();
		const optimisticUserMessage = userMessage("u1");
		queryClient.setQueryData(sessionThreadCacheKey("session-1"), [
			optimisticUserMessage,
		]);
		// Base = final Full from the backend; pendingPartial = stale partial
		// from an already-finalized turn (the +0 -0 phantom / duplicate chip).
		const accumulator: StreamAccumulator = {
			baseMessages: [assistantMessage("a1", "final answer")],
			pendingPartial: assistantMessage("stale-turn", "stale partial"),
			needsFlush: false,
			frameId: null,
			fallbackTimerId: null,
		};
		const interval = window.setInterval(() => {}, 1_000);
		const { flushStreamMessages, scheduleFlush, cleanup } =
			createStreamFlushers({
				accumulator,
				queryClient,
				cacheSessionId: "session-1",
				userMessageId: "u1",
				optimisticUserMessage,
				changesRefreshInterval: interval,
			});

		const noop = () => {};
		const deps = {
			contextKey: "ctx",
			isOverride: false,
			targetSessionId: "session-1",
			targetWorkspaceId: null,
			cacheSessionId: "session-1",
			userMessageId: "u1",
			trimmedPrompt: "prompt",
			imagePaths: [],
			filePaths: [],
			customTags: [],
			model: { id: "m", label: "m", provider: "claude" },
			optimisticUserMessage,
			rollbackSnapshot: { messages: [optimisticUserMessage] },
			accumulator,
			scheduleFlush,
			flushStreamMessages,
			cleanup,
			rememberInteractionWorkspace: noop,
			appendPendingPermission: noop,
			setPlanReviewActive: noop,
			applyUserInputEvent: noop,
			clearPendingPermissions: noop,
			clearPendingUserInput: noop,
			clearFastPrelude: noop,
			clearSendingState: noop,
			invalidateConversationQueries: noop,
			refreshSessionThreadFromDb: noop,
			pushToast: noop,
			storeActions: {
				setSendError: noop,
				setLiveSession: noop,
				setComposerRestore: noop,
			},
			streamingStore: {
				getState: () => ({ liveSessionsByContext: {} }),
			},
			queryClient,
		} as unknown as StreamDispatchDeps;

		const dispatch = createStreamEventDispatcher(deps);
		dispatch({
			kind: "done",
			provider: "claude",
			modelId: "m",
			resolvedModel: "m",
			sessionId: null,
			workingDirectory: "/tmp",
			persisted: false,
		});

		const cached = queryClient.getQueryData<ThreadMessageLike[]>(
			sessionThreadCacheKey("session-1"),
		);
		// User message + final base only — the stale partial must be gone.
		expect(cached).toHaveLength(2);
		expect(cached?.[1]?.content[0]).toEqual(
			expect.objectContaining({ text: "final answer" }),
		);
		expect(accumulator.pendingPartial).toBeNull();
	});
});
