import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { validateBranchName } from "./branch-name-validation";

export type CreateBranchDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Pre-fill the input with this prefix (e.g. `nathan/`). */
	defaultPrefix: string;
	/** Currently-known local branches; used to surface the
	 * "already exists" error inline as the user types. */
	existingBranches: ReadonlyArray<string>;
	/** Called with the trimmed final branch name on Enter / submit.
	 * Should resolve when the backend has finished `git checkout -b`. */
	onSubmit: (branch: string) => Promise<void>;
};

export function CreateBranchDialog({
	open,
	onOpenChange,
	defaultPrefix,
	existingBranches,
	onSubmit,
}: CreateBranchDialogProps) {
	const [value, setValue] = useState(defaultPrefix);
	const [submitting, setSubmitting] = useState(false);
	const [serverError, setServerError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setValue(defaultPrefix);
			setSubmitting(false);
			setServerError(null);
		}
	}, [open, defaultPrefix]);

	const validationError = useMemo(
		() => validateBranchName(value, existingBranches),
		[value, existingBranches],
	);
	const error = serverError ?? validationError;
	const canSubmit = !validationError && !submitting && value.trim().length > 0;

	async function handleSubmit(event?: React.FormEvent) {
		event?.preventDefault();
		if (!canSubmit) return;
		setSubmitting(true);
		setServerError(null);
		try {
			await onSubmit(value.trim());
			onOpenChange(false);
		} catch (err) {
			setServerError(err instanceof Error ? err.message : String(err));
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="gap-3 sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create and checkout branch</DialogTitle>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
					<label
						htmlFor="create-branch-name"
						className="text-[12px] font-medium text-muted-foreground"
					>
						Branch name
					</label>
					<Input
						id="create-branch-name"
						value={value}
						autoFocus
						placeholder="feature/awesome"
						disabled={submitting}
						aria-invalid={error ? true : undefined}
						onChange={(e) => {
							setValue(e.target.value);
							setServerError(null);
						}}
					/>
					<div
						className={cn(
							"min-h-4 text-[12px]",
							error ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{error ?? ""}
					</div>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={submitting}
							onClick={() => onOpenChange(false)}
						>
							Close
						</Button>
						<Button type="submit" size="sm" disabled={!canSubmit}>
							Create and checkout
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
