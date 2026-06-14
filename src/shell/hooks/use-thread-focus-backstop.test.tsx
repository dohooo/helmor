import { focusManager, QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__resetStreamingStoreForTests,
	useStreamingStore,
} from "@/features/conversation/state/streaming-store";
import { helmorQueryKeys } from "@/lib/query-client";
import { useThreadFocusBackstop } from "./use-thread-focus-backstop";

afterEach(() => {
	cleanup();
	focusManager.setFocused(undefined);
	__resetStreamingStoreForTests();
});

function mountBackstop(displayedSessionId: string | null) {
	const queryClient = new QueryClient();
	const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
	renderHook(() =>
		useThreadFocusBackstop({
			queryClient,
			getDisplayedSessionId: () => displayedSessionId,
		}),
	);
	return { invalidateQueries };
}

const blurThenFocus = () => {
	act(() => {
		focusManager.setFocused(false);
		focusManager.setFocused(true);
	});
};

describe("useThreadFocusBackstop", () => {
	it("refetches the displayed session's thread on window focus", () => {
		const { invalidateQueries } = mountBackstop("session-1");

		blurThenFocus();

		expect(invalidateQueries).toHaveBeenCalledTimes(1);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.sessionMessages("session-1"),
		});
	});

	it("does nothing on blur or when no session is displayed", () => {
		const { invalidateQueries } = mountBackstop(null);

		act(() => {
			focusManager.setFocused(false);
		});
		blurThenFocus();

		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("skips while a local active stream owns the session snapshot", () => {
		useStreamingStore.setState({
			activeSessionByContext: {
				"session:session-1": { stopSessionId: "stop-1", provider: "claude" },
			},
		});
		const { invalidateQueries } = mountBackstop("session-1");

		blurThenFocus();

		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("skips while a send is still in flight (sending-only state)", () => {
		useStreamingStore.setState({
			sendingContextKeys: new Set(["session:session-1"]),
		});
		const { invalidateQueries } = mountBackstop("session-1");

		blurThenFocus();

		expect(invalidateQueries).not.toHaveBeenCalled();
	});
});
