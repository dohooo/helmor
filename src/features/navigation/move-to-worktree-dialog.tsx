import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { I18nText, useI18n } from "@/lib/i18n";

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
	const { t } = useI18n();

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
					<DialogTitle>
						<I18nText source="moveIntoNewWorktree" />
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-2 text-ui leading-snug text-muted-foreground">
					<p>
						<span className="font-medium text-foreground">
							{workspaceTitle}
						</span>{" "}
						<I18nText source="willContinueFreshWorktreeNewAuto" />
					</p>
					<ul className="list-disc space-y-0.5 pl-4">
						<li>
							<I18nText source="localRepositoryStaysExactlyBranchFiles" />
						</li>
						<li>
							<I18nText source="trackedUntrackedChangesCarriedOverInto" />
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
						<I18nText source="cancel" />
					</Button>
					<Button
						type="button"
						size="sm"
						disabled={submitting}
						onClick={handleConfirm}
					>
						{submitting ? t("moving") : t("navMoveIntoWorktree")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
