// Repository deletion confirmation. Owns its own confirm dialog + delete
// loading state; emits `onDeleted` once the backend returns success so the
// parent can drop the repo out of the sidebar list.
import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteRepository, type RepositoryCreateOption } from "@/lib/api";

export function DeleteRepoSection({
	repo,
	onDeleted,
}: {
	repo: RepositoryCreateOption;
	onDeleted: () => void;
}) {
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
				<div className="flex items-center gap-2 text-[13px] font-medium leading-snug text-foreground">
					<Trash2 className="size-3.5 text-destructive" strokeWidth={1.8} />
					Delete Repository
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Permanently remove this repository and all its workspaces, sessions,
					and messages.
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
					Delete Repository
				</Button>
				{error && (
					<div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
						{error}
					</div>
				)}
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Delete ${repo.name}?`}
				description={
					<>
						This will permanently delete all workspaces, sessions, and messages
						associated with{" "}
						<strong className="text-foreground/80">{repo.name}</strong>. This
						cannot be undone.
					</>
				}
				confirmLabel={deleting ? "Deleting..." : "Delete"}
				onConfirm={() => void handleDelete()}
				loading={deleting}
			/>
		</>
	);
}
