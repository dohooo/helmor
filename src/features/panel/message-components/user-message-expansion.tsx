import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

const EMPTY_IDS: ReadonlySet<string> = new Set();

type UserMessageExpansionContextValue = {
	expandedIds: ReadonlySet<string>;
	toggle: (messageId: string) => void;
};

const UserMessageExpansionContext =
	createContext<UserMessageExpansionContextValue | null>(null);

/**
 * Session-scoped expansion state for collapsed long user messages.
 *
 * It lives above the virtualized rows on purpose: a row's local state dies
 * when the row scrolls out of the mount window, but its measured height
 * survives in the viewport's measuredHeights cache — restoring the expanded
 * state on remount keeps the render and the cached measurement consistent.
 * A session switch resets the set (the viewport clears its measurements in
 * the same commit), so every session opens with long messages collapsed.
 *
 * Context rather than props so the toggle reaches ChatUserMessage through
 * MemoConversationMessage's custom comparator without widening it.
 */
export function UserMessageExpansionProvider({
	sessionId,
	children,
}: {
	sessionId: string;
	children: ReactNode;
}) {
	const [state, setState] = useState<{
		sessionId: string;
		ids: ReadonlySet<string>;
	}>({ sessionId, ids: EMPTY_IDS });
	// Render-time reset on session switch (same pattern as the viewport's
	// lastSessionId reset).
	if (state.sessionId !== sessionId) {
		setState({ sessionId, ids: EMPTY_IDS });
	}
	const ids = state.sessionId === sessionId ? state.ids : EMPTY_IDS;

	const toggle = useCallback(
		(messageId: string) => {
			setState((current) => {
				const base = current.sessionId === sessionId ? current.ids : EMPTY_IDS;
				const next = new Set(base);
				if (next.has(messageId)) {
					next.delete(messageId);
				} else {
					next.add(messageId);
				}
				return { sessionId, ids: next };
			});
		},
		[sessionId],
	);

	const value = useMemo(() => ({ expandedIds: ids, toggle }), [ids, toggle]);

	return (
		<UserMessageExpansionContext.Provider value={value}>
			{children}
		</UserMessageExpansionContext.Provider>
	);
}

/**
 * Expansion state for one user message. Falls back to plain local state when
 * no provider is mounted (isolated renders, tests) or the message has no id —
 * collapse still works, it just won't survive a row unmount.
 */
export function useUserMessageExpansion(messageId: string | undefined): {
	expanded: boolean;
	toggle: () => void;
} {
	const context = useContext(UserMessageExpansionContext);
	const [localExpanded, setLocalExpanded] = useState(false);
	const contextToggle = context?.toggle;

	const toggle = useCallback(() => {
		if (contextToggle && messageId) {
			contextToggle(messageId);
		} else {
			setLocalExpanded((value) => !value);
		}
	}, [contextToggle, messageId]);

	const expanded =
		context && messageId ? context.expandedIds.has(messageId) : localExpanded;

	return { expanded, toggle };
}
