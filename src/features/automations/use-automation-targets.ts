import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { WorkspaceSessionSummary } from "@/lib/api";
import {
	workspaceGroupsQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";

export type WorkspaceOption = { id: string; title: string };

/** Flattened workspace list for the target pickers — reuses the sidebar's
 *  `workspaceGroups` query (no new IPC). Deduped by id since a workspace
 *  can only appear once but groups are a projection we don't control. */
export function useWorkspaceOptions(enabled = true): WorkspaceOption[] {
	const groupsQuery = useQuery({
		...workspaceGroupsQueryOptions(),
		enabled,
	});
	const groups = groupsQuery.data;
	return useMemo(() => {
		const seen = new Set<string>();
		const options: WorkspaceOption[] = [];
		for (const group of groups ?? []) {
			for (const row of group.rows) {
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				options.push({ id: row.id, title: row.title });
			}
		}
		return options;
	}, [groups]);
}

/** Visible chat sessions of a workspace — reuses the panel's
 *  `workspaceSessions` query. Hidden one-off action sessions and terminal
 *  sessions are not valid automation targets. */
export function useSessionOptions(
	workspaceId: string | null,
): WorkspaceSessionSummary[] {
	const sessionsQuery = useQuery({
		...workspaceSessionsQueryOptions(workspaceId ?? "__none__"),
		enabled: workspaceId !== null,
	});
	const sessions = sessionsQuery.data;
	return useMemo(
		() =>
			(sessions ?? []).filter(
				(session) =>
					!session.isHidden && (session.sessionKind ?? "gui") !== "terminal",
			),
		[sessions],
	);
}
