// Cache patcher used by the streaming hook to write a freshly generated
// session title into every spot that displays it: the workspace's session
// list, the workspace detail's `activeSessionTitle`, and the matching row
// in the navigation sidebar groups. Pure function — no React state.
import type { QueryClient } from "@tanstack/react-query";
import { helmorQueryKeys } from "@/lib/query-client";

export function seedSessionTitle(
	queryClient: QueryClient,
	sessionId: string,
	workspaceId: string | null,
	title: string,
): void {
	queryClient.setQueryData(
		helmorQueryKeys.workspaceSessions(workspaceId ?? "__none__"),
		(current: Array<Record<string, unknown>> | undefined) =>
			(current ?? []).map((session) =>
				session.id === sessionId ? { ...session, title } : session,
			),
	);
	if (workspaceId) {
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail(workspaceId),
			(current: Record<string, unknown> | undefined) => {
				if (!current || current.activeSessionId !== sessionId) {
					return current;
				}
				return {
					...current,
					activeSessionTitle: title,
				};
			},
		);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceGroups,
			(current: Array<Record<string, unknown>> | undefined) =>
				(current ?? []).map((group) => ({
					...group,
					rows: Array.isArray(group.rows)
						? group.rows.map((row: Record<string, unknown>) =>
								row.id === workspaceId && row.activeSessionId === sessionId
									? {
											...row,
											activeSessionTitle: title,
										}
									: row,
							)
						: group.rows,
				})),
		);
	}
}
