// History dropdown state for the panel header. Lazy-loads hidden sessions
// when the dropdown opens, mirrors locally-pruned hidden sessions, and
// auto-closes the dropdown once the list is empty.
import { useCallback, useState } from "react";
import {
	loadHiddenSessions,
	unhideSession,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";

export type HiddenHistoryController = {
	showHistory: boolean;
	hiddenSessions: WorkspaceSessionSummary[];
	toggleHistory(open: boolean): Promise<void>;
	unhide(sessionId: string): Promise<void>;
	pruneFromHistory(sessionId: string): void;
};

export function useHiddenHistory({
	workspace,
	onSelectSession,
	onSessionsChanged,
}: {
	workspace: WorkspaceDetail | null;
	onSelectSession?: (sessionId: string) => void;
	onSessionsChanged?: () => void;
}): HiddenHistoryController {
	const [showHistory, setShowHistory] = useState(false);
	const [hiddenSessions, setHiddenSessions] = useState<
		WorkspaceSessionSummary[]
	>([]);

	const toggleHistory = useCallback(
		async (open: boolean) => {
			if (open && workspace) {
				const hidden = await loadHiddenSessions(workspace.id);
				setHiddenSessions(hidden);
			}
			setShowHistory(open);
		},
		[workspace],
	);

	const unhide = useCallback(
		async (sessionId: string) => {
			await unhideSession(sessionId);
			setHiddenSessions((current) => {
				const next = current.filter((session) => session.id !== sessionId);
				if (next.length === 0) {
					setShowHistory(false);
				}
				return next;
			});
			onSessionsChanged?.();
			onSelectSession?.(sessionId);
		},
		[onSelectSession, onSessionsChanged],
	);

	const pruneFromHistory = useCallback((sessionId: string) => {
		setHiddenSessions((current) => {
			const next = current.filter((session) => session.id !== sessionId);
			if (next.length === 0) {
				setShowHistory(false);
			}
			return next;
		});
	}, []);

	return {
		showHistory,
		hiddenSessions,
		toggleHistory,
		unhide,
		pruneFromHistory,
	};
}
