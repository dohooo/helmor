// Focus-time backstop for the event-fresh thread cache. With
// `staleTime: Infinity` a missed `sessionTurnPersisted` (bridge re-subscribe
// gap or rolled-back send) would stay stale forever —
// refetch the DISPLAYED session's thread on window focus. One IPC per focus;
// background sessions still rely on events + mount refetch.
import { focusManager, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStreamingStore } from "@/features/conversation/state/streaming-store";
import { helmorQueryKeys } from "@/lib/query-client";
import { useLatestRef } from "@/shell/hooks/use-stable-actions";

export function useThreadFocusBackstop({
	queryClient,
	getDisplayedSessionId,
}: {
	queryClient: QueryClient;
	getDisplayedSessionId: () => string | null;
}) {
	const getDisplayedSessionIdRef = useLatestRef(getDisplayedSessionId);
	useEffect(() => {
		return focusManager.subscribe((focused) => {
			if (!focused) return;
			const sessionId = getDisplayedSessionIdRef.current();
			if (!sessionId) return;
			// Same liveness skip as the bridge's `sessionTurnPersisted`: a local
			// stream / in-flight send owns the cache snapshot.
			const contextKey = `session:${sessionId}`;
			const streaming = useStreamingStore.getState();
			if (
				streaming.activeSessionByContext[contextKey] !== undefined ||
				streaming.sendingContextKeys.has(contextKey)
			) {
				return;
			}
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionMessages(sessionId),
			});
		});
	}, [queryClient, getDisplayedSessionIdRef]);
}
