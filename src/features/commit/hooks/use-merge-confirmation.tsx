import { type ReactNode, useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type MergeConfirmRequest = {
	title: string;
	description: string;
	confirmLabel: string;
	resolve: (confirmed: boolean) => void;
};

export type MergeConfirmationOptions = Omit<MergeConfirmRequest, "resolve">;

export function useMergeConfirmation(): {
	requestMergeConfirmation: (
		request: MergeConfirmationOptions,
	) => Promise<boolean>;
	mergeConfirmDialogNode: ReactNode;
} {
	const [pending, setPending] = useState<MergeConfirmRequest | null>(null);

	const requestMergeConfirmation = useCallback(
		(request: MergeConfirmationOptions) =>
			new Promise<boolean>((resolve) => {
				setPending({ ...request, resolve });
			}),
		[],
	);

	const resolveConfirmation = useCallback(
		(confirmed: boolean) => {
			const request = pending;
			if (!request) return;
			setPending(null);
			request.resolve(confirmed);
		},
		[pending],
	);

	const mergeConfirmDialogNode: ReactNode = (
		<ConfirmDialog
			open={pending !== null}
			onOpenChange={(open) => {
				if (!open) resolveConfirmation(false);
			}}
			title={pending?.title ?? ""}
			description={pending?.description ?? ""}
			confirmLabel={pending?.confirmLabel ?? "Merge anyway"}
			onConfirm={() => resolveConfirmation(true)}
		/>
	);

	return { requestMergeConfirmation, mergeConfirmDialogNode };
}
