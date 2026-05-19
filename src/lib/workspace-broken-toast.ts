import type { QueryClient } from "@tanstack/react-query";
import { isRemoteRuntime } from "@/components/runtime-host-chip";
import { permanentlyDeleteWorkspace } from "@/lib/api";
import { extractError } from "@/lib/errors";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";

type ShowWorkspaceBrokenToastArgs = {
	workspaceId: string;
	pushToast: PushWorkspaceToast;
	queryClient: QueryClient;
	description?: string;
	/**
	 * Phase 22d: when present, the toast title + description name the
	 * remote host so an operator can tell at a glance "this is the
	 * dev.box workspace, not my local one" before clicking
	 * `Permanently Delete`. Pass the workspace's `runtimeName` from the
	 * caller; `null` / `"local"` / `undefined` all collapse to the
	 * legacy host-agnostic copy.
	 */
	runtimeName?: string | null;
};

/**
 * Pop a persistent, destructive toast for a workspace whose directory has
 * vanished on disk. The default action is "Dismiss" (chat history stays
 * in the archive list); the explicit "Permanently Delete" action nukes
 * the DB row + messages only after the user confirms. Never auto-deletes.
 *
 * Shared between inspector mutation failures and send-message failures so
 * the recovery UX is identical wherever `ErrorCode::WorkspaceBroken`
 * surfaces.
 */
export function showWorkspaceBrokenToast({
	workspaceId,
	pushToast,
	queryClient,
	description,
	runtimeName,
}: ShowWorkspaceBrokenToastArgs): void {
	const isRemote = isRemoteRuntime(runtimeName);
	const title = isRemote
		? `Workspace directory is missing on ${runtimeName}`
		: "Workspace directory is missing";
	const resolvedDescription =
		description ??
		(isRemote
			? `The chat history is preserved in the archive. Permanently delete this workspace on ${runtimeName} to remove it for good.`
			: "The chat history is preserved in the archive. Permanently delete to remove it for good.");
	pushToast(resolvedDescription, title, "destructive", {
		persistent: true,
		action: {
			label: "Permanently Delete",
			destructive: true,
			onClick: () => {
				void permanentlyDeleteWorkspace(workspaceId)
					.then(() => {
						requestSidebarReconcile(queryClient);
						void queryClient.removeQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						});
						void queryClient.removeQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						});
					})
					.catch((error) => {
						const { message } = extractError(
							error,
							"Failed to delete workspace.",
						);
						pushToast(message, "Unable to delete workspace", "destructive");
					});
			},
		},
	});
}
