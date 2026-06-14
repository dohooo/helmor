import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cleanupArchivedWorkspaces } from "@/lib/api";
import { archivedWorkspacesQueryOptions } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { SettingsRow } from "../components/settings-row";

/**
 * Settings → General "Clean up archived workspaces" row.
 *
 * One button that permanently deletes every archived workspace through
 * the standard backend delete path, behind an explicit confirmation
 * dialog. Once confirmed the run is backend-owned and not cancellable —
 * the dialog stays open in a loading state until the run finishes, and
 * the outcome (including partial failures) lands as a toast.
 */
export function ArchiveCleanupPanel() {
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const archivedQuery = useQuery(archivedWorkspacesQueryOptions());
	const archivedCount = archivedQuery.data?.length ?? 0;

	const cleanup = useMutation({
		mutationFn: cleanupArchivedWorkspaces,
		onSuccess: (result) => {
			if (result.failures.length === 0) {
				toast.success(
					result.deletedCount === 0
						? "No archived workspaces to clean up"
						: `Cleaned up ${result.deletedCount} archived workspace${
								result.deletedCount === 1 ? "" : "s"
							}`,
				);
				return;
			}
			toast.error(
				`Cleaned up ${result.deletedCount}, but ${result.failures.length} workspace${
					result.failures.length === 1 ? "" : "s"
				} could not be deleted`,
				{
					description: result.failures
						.map((failure) =>
							failure.title
								? `${failure.title}: ${failure.message}`
								: failure.message,
						)
						.join("\n"),
				},
			);
		},
		onError: (error) => {
			toast.error("Archive cleanup failed", {
				description: error instanceof Error ? error.message : String(error),
			});
		},
		onSettled: () => {
			setConfirmOpen(false);
			requestSidebarReconcile(queryClient);
		},
	});

	return (
		<SettingsRow
			title="Clean up archived workspaces"
			description={
				archivedCount === 0
					? "No archived workspaces."
					: `Permanently delete all ${archivedCount} archived workspace${
							archivedCount === 1 ? "" : "s"
						}, including their sessions and chat history.`
			}
		>
			<Button
				variant="outline"
				size="sm"
				disabled={archivedCount === 0 || cleanup.isPending}
				onClick={() => setConfirmOpen(true)}
			>
				{cleanup.isPending ? (
					<Loader2 className="size-3.5 animate-spin" />
				) : (
					<Trash2 className="size-3.5" />
				)}
				{cleanup.isPending ? "Cleaning up" : "Clean up"}
			</Button>
			<ConfirmDialog
				open={confirmOpen}
				// Once the run starts it cannot be cancelled — keep the dialog
				// up (with disabled buttons) so the loading state stays visible.
				onOpenChange={(open) => {
					if (!cleanup.isPending) {
						setConfirmOpen(open);
					}
				}}
				title="Clean up archived workspaces?"
				description={`This will permanently delete all ${archivedCount} archived workspace${
					archivedCount === 1 ? "" : "s"
				}, including their sessions and chat history. This cannot be undone.`}
				confirmLabel="Delete All"
				onConfirm={() => cleanup.mutate()}
				loading={cleanup.isPending}
			/>
		</SettingsRow>
	);
}
