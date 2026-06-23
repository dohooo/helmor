import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { I18nText, useI18n } from "@/lib/i18n";

export type RenameWorkspaceDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Current title shown in the sidebar — pre-fills the input. */
	currentTitle: string;
	onConfirm: (name: string) => Promise<void> | void;
};

export function RenameWorkspaceDialog({
	open,
	onOpenChange,
	currentTitle,
	onConfirm,
}: RenameWorkspaceDialogProps) {
	const [value, setValue] = useState(currentTitle);
	const [submitting, setSubmitting] = useState(false);
	const { t } = useI18n();

	useEffect(() => {
		if (open) {
			setValue(currentTitle);
			setSubmitting(false);
		}
	}, [open, currentTitle]);

	const trimmed = value.trim();
	const unchanged = trimmed === currentTitle.trim();

	async function handleConfirm() {
		if (submitting || unchanged) {
			return;
		}
		setSubmitting(true);
		try {
			await onConfirm(trimmed);
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
						<I18nText source="navRenameWorkspace" />
					</DialogTitle>
				</DialogHeader>
				<Input
					autoFocus
					value={value}
					placeholder={t("navRenameWorkspacePlaceholder")}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void handleConfirm();
						}
					}}
				/>
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
						disabled={submitting || unchanged}
						onClick={handleConfirm}
					>
						<I18nText source="save" />
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
