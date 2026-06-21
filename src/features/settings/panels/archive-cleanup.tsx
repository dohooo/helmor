import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cleanupArchivedWorkspaces } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
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
	const { f, t } = useI18n();
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const { data: archivedWorkspaces = [] } = useQuery(
		archivedWorkspacesQueryOptions(),
	);
	const archivedCount = archivedWorkspaces.length;

	const cleanup = useMutation({
		mutationFn: cleanupArchivedWorkspaces,
		onSuccess: (result) => {
			if (result.failures.length === 0) {
				toast.success(
					result.deletedCount === 0
						? t("noArchivedWorkspacesCleanUp")
						: f("cleanedUpCountArchivedWorkspacelabel", {
								count: result.deletedCount,
								workspaceLabel:
									result.deletedCount === 1 ? "workspace" : "workspaces",
							}),
				);
				return;
			}
			toast.error(
				f("cleanedUpDeletedcountButFailurecountWorkspacelab", {
					deletedCount: result.deletedCount,
					failureCount: result.failures.length,
					workspaceLabel:
						result.failures.length === 1 ? "workspace" : "workspaces",
				}),
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
			toast.error(t("archiveCleanupFailed"), {
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
			title="cleanUpArchivedWorkspaces"
			description={
				archivedCount === 0
					? "noArchivedWorkspaces"
					: f("permanentlyDeleteAllCountArchivedWorkspacelabel", {
							count: archivedCount,
							workspaceLabel: archivedCount === 1 ? "workspace" : "workspaces",
						})
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
				{cleanup.isPending ? t("settingsCleaningUp") : t("settingsCleanUp")}
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
				title="cleanUpArchivedWorkspaces2"
				description={f("willPermanentlyDeleteAllCountArchived", {
					count: archivedCount,
					workspaceLabel: archivedCount === 1 ? "workspace" : "workspaces",
				})}
				confirmLabel="deleteAll"
				onConfirm={() => cleanup.mutate()}
				loading={cleanup.isPending}
			/>
		</SettingsRow>
	);
}
