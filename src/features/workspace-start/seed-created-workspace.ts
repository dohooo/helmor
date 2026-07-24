import type { QueryClient } from "@tanstack/react-query";
import { seedNewSessionInCache } from "@/features/panel/session-cache";
import type {
	PrepareWorkspaceResponse,
	WorkspaceDetail,
	WorkspaceMode,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

/**
 * DF-1: seed the freshly-created workspace's caches SYNCHRONOUSLY so the
 * selection controller's `resolveCachedWorkspaceDisplay` hits its cached
 * fast path and the view flips to the new workspace immediately.
 *
 * Without these seeds the flip falls into the cold-target HOLD: the old
 * pane stays on screen until `primeWorkspaceDisplay` round-trips the
 * network (≥2.3s on team cloud, indefinitely in asleep/boot windows) —
 * the "my first message vanished" start-page bug.
 *
 * Three caches must hit for the fast path:
 * - `workspaceDetail`  — minimal synthetic; the real fetch overwrites it.
 *   (The chat variant also keeps the inspector pane's `mode` gate stable
 *   on first mount — see the original inline comment history.)
 * - `workspaceSessions` — one optimistic row for the initial session,
 *   via the same idempotent seeder the sidebar "New session" flow uses
 *   (dedup by id, so the authoritative list replacing it can never
 *   produce duplicate rows).
 * - session thread — empty array so the panel's
 *   `messagesQuery.data === undefined` gate doesn't suppress the
 *   optimistic first user bubble.
 */
export function seedCreatedWorkspaceCaches({
	queryClient,
	prepared,
	mode,
	workingDirectory,
}: {
	queryClient: QueryClient;
	prepared: PrepareWorkspaceResponse;
	mode: WorkspaceMode;
	workingDirectory: string | null;
}): void {
	const base = {
		id: prepared.workspaceId,
		hasUnread: false,
		workspaceUnread: 0,
		unreadSessionCount: 0,
		status: "in-progress" as const,
		sessionCount: 1,
		messageCount: 0,
		rootPath: workingDirectory,
		activeSessionId: prepared.initialSessionId,
	};
	const synthetic: WorkspaceDetail =
		mode === "chat"
			? {
					...base,
					title: "New chat",
					repoId: "",
					repoName: "Chats",
					directoryName: "",
					state: "ready",
					mode: "chat",
				}
			: {
					...base,
					title: prepared.directoryName,
					repoId: prepared.repoId,
					repoName: prepared.repoName,
					directoryName: prepared.directoryName,
					state: prepared.state,
					branch: prepared.branch,
					mode,
				};
	queryClient.setQueryData<WorkspaceDetail | null>(
		helmorQueryKeys.workspaceDetail(prepared.workspaceId),
		(existing) => existing ?? synthetic,
	);
	seedNewSessionInCache({
		queryClient,
		workspaceId: prepared.workspaceId,
		sessionId: prepared.initialSessionId,
		existingSessions: [],
	});
}
