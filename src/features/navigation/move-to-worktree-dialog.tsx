import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export type MoveToWorktreeDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceTitle: string;
	onConfirm: () => Promise<void> | void;
};

// Confirmation for move-to-worktree — silent mode flip on a click is
// surprising even though the action is reversible.
export function MoveToWorktreeDialog({
	open,
	onOpenChange,
	workspaceTitle,
	onConfirm,
}: MoveToWorktreeDialogProps) {
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (open) {
			setSubmitting(false);
		}
	}, [open]);

	async function handleConfirm() {
		setSubmitting(true);
		try {
			await onConfirm();
			onOpenChange(false);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-3 sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Move into a new worktree</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-2 text-[13px] leading-snug text-muted-foreground">
					<p>
						<span className="font-medium text-foreground">
							{workspaceTitle}
						</span>{" "}
						will continue in a fresh worktree on a new auto-named branch.
					</p>
					<ul className="list-disc space-y-0.5 pl-4">
						<li>
							Your local repository stays exactly as it is — branch and files
							untouched.
						</li>
						<li>
							Tracked + untracked changes are carried over into the new
							worktree.
						</li>
					</ul>
				</div>
				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={submitting}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						size="sm"
						disabled={submitting}
						onClick={handleConfirm}
					>
						{submitting ? "Moving…" : "Move into worktree"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
