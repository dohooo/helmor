import type { WorkspaceSessionSummary } from "@/lib/api";
import { isSessionRunningStatus } from "./session-running";

export function shouldConfirmRunningSessionClose(
	session: WorkspaceSessionSummary,
	busySessionIds?: Set<string>,
): boolean {
	return (
		busySessionIds?.has(session.id) === true ||
		isSessionRunningStatus(session.status)
	);
}
