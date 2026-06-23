// DEV-ONLY reproduction tool for the "in-review workspace opens empty" bug.
//
// It does NOT fake the empty panel. It runs the SAME real code path the
// create-PR / commit "done-phase" runs (`features/commit/hooks/use-commit-
// lifecycle.ts`), just without needing an actual PR push:
//   1. `setWorkspaceStatus(id, "review")`  — real command, moves it to the
//      In-review bucket (this is the "data prep" we skip).
//   2. `hideSession(currentSessionId)`     — real command, mirrors the action
//      session being auto-closed. The backend reassigns `active_session_id`
//      to an adjacent VISIBLE session, or to NULL when none remain.
//   3. invalidate sessions + detail, then `onSelectSession(activeSessionId ??
//      null)` — the exact line that strands the panel on "No session selected"
//      when the resolved active session is null.
//
// So the empty state, if it appears, is produced by the real selection logic —
// which is the whole point: after the fix, clicking this should NOT empty.
//
// Gated to dev builds (never ships, never renders in tests).
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	hideSession,
	setWorkspaceStatus,
	type WorkspaceDetail,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";

type Props = {
	workspaceId: string | null;
	sessionId: string | null;
	onSelectSession: (sessionId: string | null) => void;
};

export function ReproInReviewEmptyButton({
	workspaceId,
	sessionId,
	onSelectSession,
}: Props) {
	const queryClient = useQueryClient();
	const [running, setRunning] = useState(false);

	const disabled = !workspaceId || !sessionId || running;

	const run = async () => {
		if (!workspaceId || !sessionId || running) {
			return;
		}
		setRunning(true);
		try {
			// 1) Real transition into the In-review bucket.
			await setWorkspaceStatus(workspaceId, "review");
			requestSidebarReconcile(queryClient);

			// 2) Real auto-close of the currently-shown session.
			await hideSession(sessionId);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
				}),
			]);

			// 3) Real re-selection — null when no visible session remains.
			const detail = queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail(workspaceId),
			);
			onSelectSession(detail?.activeSessionId ?? null);
		} catch (error) {
			console.error("[repro-in-review-empty] failed:", error);
		} finally {
			setRunning(false);
		}
	};

	return (
		<button
			type="button"
			onClick={run}
			disabled={disabled}
			title="DEV: reproduce the in-review-empty bug — runs the real create-PR done-phase (status→review + hide current session + reselect active). Use a workspace whose ONLY visible session is the one shown."
			className="fixed right-4 bottom-4 z-[9999] cursor-pointer rounded-md border border-amber-500/60 bg-amber-500/15 px-2.5 py-1 font-mono text-[11px] text-amber-300 shadow-lg backdrop-blur transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
		>
			{running ? "… running" : "🐞 repro in-review-empty"}
		</button>
	);
}
