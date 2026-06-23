// Repository deletion confirmation. Owns its own confirm dialog + delete
// loading state; emits `onDeleted` once the backend returns success so the
// parent can drop the repo out of the sidebar list.
import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteRepository, type RepositoryCreateOption } from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";

export function DeleteRepoSection({
	repo,
	onDeleted,
}: {
	repo: RepositoryCreateOption;
	onDeleted: () => void;
}) {
	const { f } = useI18n();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		setDeleting(true);
		setError(null);
		try {
			await deleteRepository(repo.id);
			setConfirmOpen(false);
			onDeleted();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setDeleting(false);
		}
	}, [repo.id, onDeleted]);

	return (
		<>
			<div className="py-5">
				<div className="flex items-center gap-2 text-ui font-medium leading-snug text-foreground">
					<Trash2 className="size-3.5 text-destructive" strokeWidth={1.8} />
					<I18nText source="deleteRepository" />
				</div>
				<div className="mt-1 text-small leading-snug text-muted-foreground">
					<I18nText source="permanentlyRemoveRepositoryAllItsWorkspaces" />
				</div>
				<Button
					variant="destructive"
					size="sm"
					className="mt-3"
					onClick={() => {
						setError(null);
						setConfirmOpen(true);
					}}
				>
					<I18nText source="deleteRepository" />
				</Button>
				{error && (
					<div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-small text-destructive">
						{error}
					</div>
				)}
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={f("settingsDeleteRepoNameConfirm", { name: repo.name })}
				description={
					<>
						<I18nText source="willPermanentlyDeleteAllWorkspacesSessions" />{" "}
						<strong className="text-foreground/80">{repo.name}</strong>
						<I18nText source="cannotUndone" />
					</>
				}
				confirmLabel={deleting ? "deleting" : "delete"}
				onConfirm={() => void handleDelete()}
				loading={deleting}
			/>
		</>
	);
}
