import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessageLike } from "@/lib/api";
import { sessionThreadCacheKey } from "@/lib/session-thread-cache";
import {
	createStreamFlushers,
	type StreamAccumulator,
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
