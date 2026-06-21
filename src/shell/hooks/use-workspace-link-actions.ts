import { useCallback } from "react";
import { toast } from "sonner";
import { translateSource } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";

/**
 * Workspace link/path helpers AppShell hands to its header actions: copy the
 * workspace root path to the clipboard, and open the workspace's pull request
 * in the browser. Extracted verbatim from AppShell (Phase 2 split).
 *
 * The resolved `workspaceRootPath` / `pullRequestUrl` and the toast pusher are
 * passed in so the hook stays decoupled from AppShell's query wiring.
 * Dependency arrays are preserved exactly as the original inline callbacks.
 */
export function useWorkspaceLinkActions({
	workspaceRootPath,
	pullRequestUrl,
	pushWorkspaceToast,
}: {
	workspaceRootPath: string | null;
	pullRequestUrl: string | null;
	pushWorkspaceToast: PushWorkspaceToast;
}) {
	const handleCopyWorkspacePath = useCallback(() => {
		if (!workspaceRootPath) return;
		void navigator.clipboard.writeText(workspaceRootPath).then(() => {
			toast.success(translateSource("miscPathCopied"), {
				description: workspaceRootPath,
				duration: 2000,
			});
		});
	}, [workspaceRootPath]);

	const handleOpenPullRequest = useCallback(() => {
		if (!pullRequestUrl) return;
		void openUrl(pullRequestUrl).catch((error) => {
			pushWorkspaceToast(
				error instanceof Error ? error.message : String(error),
				translateSource("miscUnableToOpenPullRequest"),
				"destructive",
			);
		});
	}, [pullRequestUrl, pushWorkspaceToast]);

	return { handleCopyWorkspacePath, handleOpenPullRequest };
}
