import { createContext, useContext } from "react";

export type WorkspaceToastVariant = "default" | "destructive";

export type WorkspaceToastOptions = {
	action?: { label: string; onClick: () => void; destructive?: boolean };
	persistent?: boolean;
};

export type PushWorkspaceToast = (
	description: string,
	title?: string,
	variant?: WorkspaceToastVariant,
	opts?: WorkspaceToastOptions,
) => void;

const noop: PushWorkspaceToast = import.meta.env.DEV
	? (description) => {
			console.warn(
				"useWorkspaceToast() called outside <WorkspaceToastProvider>. Toast silently dropped:",
				description,
			);
		}
	: () => {};

const WorkspaceToastContext = createContext<PushWorkspaceToast>(noop);

export const WorkspaceToastProvider = WorkspaceToastContext.Provider;

/**
 * Returns the workspace-level toast pusher. When used outside a provider it
 * falls back to a no-op so callers don't need to null-check.
 */
export function useWorkspaceToast(): PushWorkspaceToast {
	return useContext(WorkspaceToastContext);
}
