import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { helmorQueryKeys } from "@/lib/query-client";
import { handleUiMutation } from "./use-ui-sync-bridge";

/**
 * Behavioral tests for the `roomChatMessageAppended` bridge case (WP3
 * sender-aware handling). The event must NEVER trigger an active thread
 * refetch (the S4/S6 clobber race); a self-origin echo is a pure ack, a
 * teammate's message only marks the thread stale for the next mount.
 */
function makeCtx() {
	const invalidateQueries = vi.fn();
	const queryClient = { invalidateQueries } as unknown as QueryClient;
	const options = {
		processPendingCliSends: vi.fn(),
		reloadSettings: vi.fn(),
		onWorkspaceReveal: vi.fn(),
	};
	return { invalidateQueries, queryClient, options };
}

describe("handleUiMutation — roomChatMessageAppended (sender-aware)", () => {
	it("skips the thread reconcile for a self-origin echo (authorId === ownMemberId)", () => {
		const { invalidateQueries, queryClient, options } = makeCtx();
		handleUiMutation(
			{ type: "roomChatMessageAppended", sessionId: "s1", authorId: "42" },
			queryClient,
			options,
			"42",
		);
		// Our optimistic row + the Plane 1 watch-stream echo already show it.
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("marks a BACKGROUND session's thread stale (not active) for a teammate's message", () => {
		const { invalidateQueries, queryClient, options } = makeCtx();
		handleUiMutation(
			{ type: "roomChatMessageAppended", sessionId: "s1", authorId: "99" },
			queryClient,
			{ ...options, getDisplayedSessionId: () => "other-session" },
			"42",
		);
		expect(invalidateQueries).toHaveBeenCalledTimes(1);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.sessionMessages("s1"),
			refetchType: "none",
		});
	});

	it("R2-E (correction A): a teammate's message for the DISPLAYED session refetches ACTIVELY", () => {
		// The watch stream is turn-driven now — teammate room chat (no turn)
		// can only arrive via this event. For the session on screen the user
		// must see it live: active refetch against the D1 mirror (Stage B
		// wrote the row before this event fanned out — no container wake),
		// safe under the WP3 merge rules.
		const { invalidateQueries, queryClient, options } = makeCtx();
		handleUiMutation(
			{ type: "roomChatMessageAppended", sessionId: "s1", authorId: "99" },
			queryClient,
			{ ...options, getDisplayedSessionId: () => "s1" },
			"42",
		);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: helmorQueryKeys.sessionMessages("s1"),
			refetchType: "active",
		});
	});

	it("correction A stays sender-aware: a SELF echo for the displayed session is still a pure ack", () => {
		const { invalidateQueries, queryClient, options } = makeCtx();
		handleUiMutation(
			{ type: "roomChatMessageAppended", sessionId: "s1", authorId: "42" },
			queryClient,
			{ ...options, getDisplayedSessionId: () => "s1" },
			"42",
		);
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("treats the event as non-self while our own member id is unresolved (null)", () => {
		const { invalidateQueries, queryClient, options } = makeCtx();
		handleUiMutation(
			{ type: "roomChatMessageAppended", sessionId: "s1", authorId: "42" },
			queryClient,
			options,
			null,
		);
		expect(invalidateQueries).toHaveBeenCalledTimes(1);
	});

	it("treats a null-author event as non-self (mark stale)", () => {
		const { invalidateQueries, queryClient, options } = makeCtx();
		handleUiMutation(
			{ type: "roomChatMessageAppended", sessionId: "s1", authorId: null },
			queryClient,
			options,
			"42",
		);
		expect(invalidateQueries).toHaveBeenCalledTimes(1);
	});
});
