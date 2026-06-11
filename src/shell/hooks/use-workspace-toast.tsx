import { CircleAlertIcon } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import type { WorkspaceToastOptions } from "@/lib/workspace-toast-context";

/**
 * Stable `pushWorkspaceToast` callback — surfaces workspace-level errors and
 * notices through sonner. Extracted verbatim from AppShell (Phase 1 split).
 *
 * The `useCallback` has empty deps and references only module-level symbols
 * (`toast`, `CircleAlertIcon`, `WorkspaceToastOptions`), so its identity stays
 * stable across renders — `WorkspaceToastProvider`'s value never churns.
 */
export function useWorkspaceToast() {
	return useCallback(
		(
			description: string,
			title = "Action failed",
			variant: "default" | "destructive" = "destructive",
			opts?: {
				action?: WorkspaceToastOptions["action"];
				persistent?: boolean;
			},
		) => {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const action = opts?.action
				? {
						label: opts.action.label,
						onClick: () => {
							opts.action?.onClick();
							toast.dismiss(id);
						},
					}
				: undefined;
			const cancel = opts?.action
				? {
						label: "Dismiss",
						onClick: () => {
							toast.dismiss(id);
						},
					}
				: undefined;
			const toastOptions = {
				id,
				description,
				duration: opts?.persistent ? Number.POSITIVE_INFINITY : 4200,
				action,
				cancel,
			};

			if (variant === "destructive") {
				// Inline the alert icon inside the title so it sits on the same
				// line (sonner's default icon slot is hidden for the error variant
				// via `errorToastClass` — see `components/ui/sonner.tsx`).
				const titleNode = (
					<span className="inline-flex items-center gap-1.5">
						<CircleAlertIcon className="size-3.5 shrink-0" />
						<span>{title}</span>
					</span>
				);
				toast.error(titleNode, toastOptions);
				return;
			}

			toast(title, toastOptions);
		},
		[],
	);
}
